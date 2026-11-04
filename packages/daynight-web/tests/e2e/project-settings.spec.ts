import { decodeMembersJson, parseMembers } from "../../src/api/auth-parse";
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import { decodeProjectJson } from '../../src/api/project-json';
import { project as parseProject } from '../../src/api/parse';
import { stringifyApiJson } from '../../src/api/json';
import { authenticatedAPI, bearerContext, type AuthenticatedAPI } from './authentication';
import { createProject, expect, seedProjectSettingsVersion, test } from './fixtures';

const screenshot = async (page: Page, info: TestInfo, name: string): Promise<void> => {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: false, animations: 'disabled' });
  await info.attach('scenario-screenshot', { path, contentType: 'image/png' });
};
const settings = async (request: AuthenticatedAPI, id: string) => {
  const response = await request.get(`/api/v1/projects/${id}`);
  expect(response.status(), 'Authorized project read succeeds').toBe(200);
  return parseProject(await decodeProjectJson(new Response(await response.text()))).settings;
};
const save = async (request: AuthenticatedAPI, id: string, version: bigint, minutes: number) => {
  const response = await request.patch(`/api/v1/projects/${id}/settings`, {
    headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version, executionWarningMinutes: minutes }),
  });
  expect(response.status(), 'Independent administrator settings write succeeds').toBe(200);
  return parseProject(await decodeProjectJson(new Response(await response.text()))).settings;
};
const memberList = async (request: AuthenticatedAPI, id: string) => {
  const response = await request.get(`/api/v1/projects/${id}/members`);
  expect(response.status()).toBe(200);
  return parseMembers(await decodeMembersJson(new Response(await response.text())), id);
};
const userId = async (request: AuthenticatedAPI): Promise<string> => {
  const response = await request.get('/api/v1/me'); expect(response.status()).toBe(200);
  return (await response.json() as { id: string }).id;
};
const expectNarrowLayout = async (page: Page): Promise<void> => {
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator('.project-settings-panel')).toBeInViewport({ ratio: 1 });
  expect(await page.locator('.project-settings-panel').evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const controls = element.querySelectorAll('input, button');
    return panel.left >= 0 && panel.right <= window.innerWidth
      && [...controls].every((control) => {
        const bounds = control.getBoundingClientRect();
        return bounds.width > 0 && bounds.left >= panel.left && bounds.right <= panel.right;
      });
  }), 'Saved form and every control fit within the narrow panel').toBe(true);
  expect(await page.locator('.project-management-nav').evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= window.innerWidth
      && [...element.querySelectorAll('a')].every((link) => {
        const item = link.getBoundingClientRect();
        return item.width > 0 && item.left >= bounds.left && item.right <= bounds.right && link.scrollWidth <= link.clientWidth;
      });
  }), 'Every project navigation link remains readable within the viewport').toBe(true);
  expect(await page.locator('.project-settings-panel').evaluate((element) =>
    [...element.querySelectorAll('label, .hint, h2, .panel-heading p, button')].every((item) => item.scrollWidth <= item.clientWidth)),
  'Threshold labels, guidance and actions wrap without clipping').toBe(true);
};

test.use({ trace: 'off', screenshot: 'off' });
test('project-settings', { annotation: { type: 'scenario', description: 'project-settings' } }, async ({ page, context, api, playwright, baseURL, allowBrowserWrites }, info) => {
  if (baseURL === undefined) throw new Error('Settings acceptance requires the actual service origin.');
  const bob = await bearerContext(playwright.request, baseURL, 'bob');
  const evidence = {
    scenario: 'project-settings', source: 'tests/e2e/project-settings.spec.ts', topology: process.env.DAYNIGHT_ACCEPTANCE_TARGET,
    serviceOrigin: baseURL, projectId: '', isolatedProjectId: '', exactInitialVersion: '9007199254740993',
    writes: [] as { body: string | null; status: number; response: string; requestId: string | null; responseLost: boolean }[],
    observations: [] as { label: string; version: string; executionWarningMinutes: number }[],
    faults: ['The real settings PATCH commits through the authenticated browser request context before its response is aborted; its following project GET is independently aborted until an explicit read retry.'],
    layouts: [] as { language: string; width: number; passed: boolean }[],
  };
  let loseResponse = false;
  let blockRead = false;
  try {
    const own = await createProject(bob, { name: `执行提醒阈值 Project settings with a long title ${randomUUID()}` });
    const isolated = await createProject(api, { name: `Independent threshold ${randomUUID()}` });
    evidence.projectId = own.id; evidence.isolatedProjectId = isolated.id;
    const projectPath = `/api/v1/projects/${own.id}`;
    const settingsPath = `${projectPath}/settings`;
    const browserWrites: string[] = [];
    page.on('request', (request) => { if (request.method() === 'PATCH') browserWrites.push(request.url()); });
    allowBrowserWrites([{ method: 'PATCH', url: `${baseURL}${settingsPath}`, count: 4 }]);
    const invitation = await bob.post(`${projectPath}/invitations`, { data: {} }); expect(invitation.status()).toBe(201);
    const link = (await invitation.json() as { link: string }).link;
    expect((await api.post('/api/v1/invitations/accept', { data: { token: new URL(link).hash.slice(1) } })).status()).toBe(200);
    const aliceId = await userId(api); const bobId = await userId(bob);
    const invitedAlice = (await memberList(bob, own.id)).items.find((member) => member.userId === aliceId)!;
    expect((await bob.patch(`${projectPath}/members/${aliceId}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: invitedAlice.directGrant!.version, role: 'admin', expectedUserId: bobId }) })).status()).toBe(200);
    const exact = 9_007_199_254_740_993n;
    await seedProjectSettingsVersion(own.id, exact);
    const observe = async (label: string, actor = api, id = own.id) => {
      const value = await settings(actor, id);
      evidence.observations.push({ label, version: value.version.toString(), executionWarningMinutes: value.executionWarningMinutes });
      return value;
    };
    expect(await observe('initial-exact-version')).toEqual({ version: exact, executionWarningMinutes: 60 });
    await page.route(`**${projectPath}`, async (route) => {
      if (blockRead) await route.abort('connectionfailed'); else await route.continue();
    });
    await page.route(`**${settingsPath}`, async (route) => {
      expect(route.request().method()).toBe('PATCH');
      const response = await authenticatedAPI(context.request).fetch(route.request(), { timeout: 15_000, maxRetries: 0 });
      const body = await response.text();
      evidence.writes.push({ body: route.request().postData(), status: response.status(), response: body,
        requestId: response.headers()['x-request-id'] ?? null, responseLost: loseResponse });
      if (loseResponse) { expect(response.status()).toBe(200); blockRead = true; await route.abort('connectionfailed'); }
      else await route.fulfill({ status: response.status(), headers: response.headers(), body });
    });
    await page.goto(`/projects/${own.id}/settings`);
    const threshold = page.getByRole('spinbutton', { name: '提醒阈值', exact: true });
    const submit = page.getByRole('button', { name: '保存设置', exact: true });
    await expect(threshold).toHaveValue('60'); await expect(threshold).toBeEnabled();
    await expect(page).toHaveTitle('项目设置 · Daynight');
    await expect(page.getByRole('navigation', { name: '项目设置', exact: true }).getByRole('link', { name: '项目设置', exact: true })).toHaveAttribute('aria-current', 'page');
    await threshold.fill('90'); await submit.click();
    await expect(page.getByRole('status').filter({ hasText: '设置已保存。' })).toBeVisible();
    expect(evidence.writes[0]!.body).toBe('{"version":9007199254740993,"executionWarningMinutes":90}');
    expect(evidence.writes[0]!.response).toContain('"version":9007199254740994');
    expect(await observe('independent-owner-read-after-direct-admin-save', bob)).toEqual({ version: exact + 1n, executionWarningMinutes: 90 });
    expect(await observe('other-project-remains-default', api, isolated.id)).toEqual({ version: 1n, executionWarningMinutes: 60 });
    await page.reload(); await expect(threshold).toHaveValue('90');
    for (const locale of ['zh-CN', 'en'] as const) {
      await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption(locale);
      await expect(page).toHaveTitle(locale === 'en' ? 'Project settings · Daynight' : '项目设置 · Daynight');
      await expect(page.getByRole('spinbutton', { name: locale === 'en' ? 'Alert threshold' : '提醒阈值', exact: true })).toHaveValue('90');
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await expectNarrowLayout(page); evidence.layouts.push({ language: locale, width, passed: true });
        await screenshot(page, info, `settings-admin-${locale}-${width}`);
      }
    }
    await page.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    await page.setViewportSize({ width: 1600, height: 1100 });

    expect(await save(api, own.id, exact + 1n, 75)).toEqual({ version: exact + 2n, executionWarningMinutes: 75 });
    await threshold.fill('95'); await submit.click();
    await expect(page.getByRole('status').filter({ hasText: '设置已被其他人修改' })).toBeVisible();
    await expect(threshold).toHaveValue('75'); await expect(submit).toBeDisabled();
    expect(evidence.writes[1]).toMatchObject({ body: '{"version":9007199254740994,"executionWarningMinutes":95}', status: 409 });
    expect(browserWrites).toHaveLength(2);

    loseResponse = true;
    await threshold.fill('100'); await submit.click();
    await expect(page.getByRole('button', { name: '读取当前设置', exact: true })).toBeVisible();
    await expect(submit).toBeDisabled(); await expect(threshold).toBeDisabled();
    expect(evidence.writes[2]).toMatchObject({ body: '{"version":9007199254740995,"executionWarningMinutes":100}', status: 200, responseLost: true });
    expect(await observe('committed-before-lost-response-read-retry', bob)).toEqual({ version: exact + 3n, executionWarningMinutes: 100 });
    expect(browserWrites).toHaveLength(3);
    await screenshot(page, info, 'settings-uncertain-read-required');
    blockRead = false; loseResponse = false;
    await page.getByRole('button', { name: '读取当前设置', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '已读取当前保存设置' })).toBeVisible();
    await expect(threshold).toHaveValue('100'); await expect(threshold).toBeEnabled(); expect(browserWrites).toHaveLength(3);

    const bobMember = (await memberList(api, own.id)).items.find((member) => member.userId === bobId)!;
    expect((await api.patch(`${projectPath}/members/${bobId}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: bobMember.directGrant!.version, role: 'member', expectedUserId: aliceId }) })).status()).toBe(200);
    const ownerAccess = await bob.get(`${projectPath}/access`);
    expect(ownerAccess.status()).toBe(200);
    expect(await ownerAccess.json()).toMatchObject({ effectiveRole: 'admin', directGrant: { role: 'member' } });
    const aliceMember = (await memberList(bob, own.id)).items.find((member) => member.userId === aliceId)!;
    expect((await bob.patch(`${projectPath}/members/${aliceId}`, { headers: { 'Content-Type': 'application/json' }, data: stringifyApiJson({ version: aliceMember.directGrant!.version, role: 'member', expectedUserId: bobId }) })).status()).toBe(200);
    await threshold.fill('110'); await submit.click();
    await expect(page.getByRole('status').filter({ hasText: '项目权限已变化' })).toBeVisible();
    await expect(page.getByText('你可以查看此设置，只有项目管理员可以修改。', { exact: true })).toBeVisible();
    await expect(threshold).toHaveValue('100'); await expect(threshold).toBeDisabled(); await expect(submit).toHaveCount(0);
    expect(evidence.writes[3]).toMatchObject({ body: '{"version":9007199254740996,"executionWarningMinutes":110}', status: 403 });
    expect(browserWrites).toHaveLength(4);
    expect(await observe('denied-direct-member-save-preserves-threshold', api)).toEqual({ version: exact + 3n, executionWarningMinutes: 100 });
    await page.reload(); await expect(threshold).toHaveValue('100'); await expect(threshold).toBeDisabled(); await expect(submit).toHaveCount(0);
    await page.goto(`/projects/${isolated.id}/settings`); await expect(threshold).toHaveValue('60'); await expect(threshold).toBeEnabled();
    await page.goto(`/projects/${own.id}/settings`); await expect(threshold).toHaveValue('100'); await expect(threshold).toBeDisabled(); expect(browserWrites).toHaveLength(4);
    await screenshot(page, info, 'settings-member-readonly-after-permission-recheck');
    expect(evidence.writes.map(({ status }) => status)).toEqual([200, 409, 200, 403]);
  } finally {
    await page.unrouteAll({ behavior: 'wait' });
    await bob.dispose();
    const path = info.outputPath('project-settings-receipt.json');
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`);
    await info.attach('project-settings-receipt', { path, contentType: 'application/json' });
  }
});
