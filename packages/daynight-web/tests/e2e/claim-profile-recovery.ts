import { randomUUID } from 'node:crypto';
import type { Page, TestInfo } from '@playwright/test';
import { decodeMembersJson, parseMembers, parseUser } from '../../src/api/auth-parse';
import { readWorkerClaim } from '../../src/api/task-properties';
import type { AuthenticatedAPI } from './authentication';
import { fulfillAuthenticatedResponse } from './authentication';
import { createProject, createTask, expect, type Task } from './fixtures';

// The responses cross the production decoder, shared profile hook and task surface.
export const verifyClaimProfileRecovery = async (page: Page, api: AuthenticatedAPI, info: TestInfo): Promise<void> => {
  const project = await createProject(api, { name: 'Claim profile recovery' });
  const identity = await api.get('/api/v1/me');
  expect(identity.status()).toBe(200);
  const caller = parseUser(await identity.json());
  const task = await createTask(api, project.id, { title: 'Claim profile recovery', assignedTo: caller.id });
  const endpoint = `/api/v1/projects/${project.id}/tasks/${task.id}`;
  const enabledResponse = await api.patch(endpoint, { data: { version: task.version, allowAgents: true } });
  expect(enabledResponse.status()).toBe(200);
  const enabled = await enabledResponse.json() as Task;
  const claimedResponse = await api.post(`${endpoint}/worker-claim`, { headers: { 'Daynight-Worker-Protocol': '2' }, data: {
    version: enabled.version, claimId: randomUUID(), workerId: randomUUID(), machine: { id: randomUUID(), name: 'profile-fixture.local' },
    platform: 'linux', agent: 'codex', agentControlMode: 'herdr', worktreeId: randomUUID(),
  } });
  expect(claimedResponse.status()).toBe(200);
  const claimed = await claimedResponse.json() as Task;
  const membersResponse = await api.get(`/api/v1/projects/${project.id}/members`);
  expect(membersResponse.status()).toBe(200);
  const members = parseMembers(await decodeMembersJson(new Response(await membersResponse.text())), project.id);
  const owner = members.find(member => member.userId === caller.id)!;
  const ownerLabel = owner.profile.name ?? owner.profile.email ?? owner.userId;
  const membersURL = `**/api/v1/projects/${project.id}/members`;
  const accessURL = `**/api/v1/projects/${project.id}/access`;
  let responseKind: 'network' | 'legacy' | 'ready' = 'network';
  let membersReads = 0;
  let releaseAccess: (() => void) | undefined;
  let holdAccess = false;
  let accessReads = 0;
  let reader: Page | undefined;
  const writes: string[] = [];
  const watch = (request: import('@playwright/test').Request) => {
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  };
  page.context().on('request', watch);
  await page.route(membersURL, async route => {
    membersReads++;
    if (responseKind === 'network') { await route.abort('failed'); return; }
    if (responseKind === 'legacy') {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Daynight-User-ID': caller.id }, body: JSON.stringify({ items: [{
        projectId: project.id, userId: caller.id, ...owner.profile, role: 'admin', version: 1,
        createdAt: project.createdAt, updatedAt: project.updatedAt,
      }] }) });
      return;
    }
    await fulfillAuthenticatedResponse(route, await api.get(`/api/v1/projects/${project.id}/members`));
  });
  await page.route(accessURL, async route => {
    accessReads++;
    if (holdAccess) await new Promise<void>(resolve => { releaseAccess = resolve; });
    await fulfillAuthenticatedResponse(route, await api.get(`/api/v1/projects/${project.id}/access`));
  });
  try {
    await page.goto(`/projects/${project.id}/tasks/${task.id}`);
    const root = page.locator('.task-detail-page');
    await root.getByRole('combobox', { name: '语言 / Language', exact: true }).selectOption('zh-CN');
    const claim = root.locator('.task-claim');
    const retry = claim.getByRole('button', { name: '重试成员资料', exact: true });
    const withdraw = claim.getByRole('button', { name: '强制撤回', exact: true });
    await expect(retry).toBeVisible();
    await expect(claim.getByRole('alert')).toHaveText(/无法读取认领用户资料/);
    await expect(claim.getByRole('alert')).not.toHaveText(/撤回权限/);
    await expect(withdraw).toBeEnabled();
    await expect(claim.locator('strong')).toHaveText(caller.id);
    await root.getByRole('tab', { name: '讨论', exact: true }).click();
    const draft = root.getByRole('textbox', { name: '讨论消息', exact: true });
    await draft.fill('  Unsaved claim profile recovery draft\n\n  preserved indentation\n');
    const draftText = await draft.inputValue();
    const firstReads = membersReads;
    await retry.click();
    await expect.poll(() => membersReads).toBeGreaterThan(firstReads);
    await expect(retry).toBeVisible();
    await expect(draft).toHaveValue(draftText);
    responseKind = 'legacy';
    await retry.click();
    await expect(claim.getByRole('alert')).toHaveText(/当前页面无法读取/);
    await expect(claim.getByRole('alert')).not.toHaveText(/撤回权限/);
    await expect(withdraw).toBeEnabled();
    await expect(draft).toHaveValue(draftText);
    const failedScreenshot = info.outputPath('claim-profile-protocol.png');
    await page.screenshot({ path: failedScreenshot });
    await info.attach('claim-profile-protocol', { path: failedScreenshot, contentType: 'image/png' });
    const recovery = claim.getByRole('link', { name: '在新标签页打开任务', exact: true });
    await expect(recovery).toHaveAttribute('target', '_blank');
    await expect(recovery).toHaveAttribute('rel', 'noopener noreferrer');
    const popup = page.waitForEvent('popup');
    await recovery.click();
    reader = await popup;
    await reader.waitForLoadState('domcontentloaded');
    await expect(reader.locator('.task-claim-owner strong')).toHaveText(ownerLabel);
    await expect(reader.locator('.task-claim [role="alert"]')).toHaveCount(0);
    await expect(reader.locator('.task-status-trigger')).toHaveText(/进行中|In progress/);
    await expect(draft).toHaveValue(draftText);
    expect(await reader.evaluate(() => window.opener === null)).toBe(true);
    await reader.close(); reader = undefined;
    responseKind = 'ready';
    await retry.click();
    await expect(claim.locator('strong')).toHaveText(ownerLabel);
    await expect(claim.getByRole('alert')).toHaveCount(0);
    await expect(draft).toHaveValue(draftText);
    await expect(withdraw).toBeEnabled();
    holdAccess = true;
    const previousAccessReads = accessReads;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => accessReads).toBeGreaterThan(previousAccessReads);
    await expect(withdraw).toHaveCount(0);
    expect(releaseAccess).toBeDefined();
    holdAccess = false; releaseAccess!(); releaseAccess = undefined;
    await expect(withdraw).toBeEnabled();
    await expect(draft).toHaveValue(draftText);
    const readyScreenshot = info.outputPath('claim-profile-recovered.png');
    await page.screenshot({ path: readyScreenshot });
    await info.attach('claim-profile-recovered', { path: readyScreenshot, contentType: 'image/png' });
    const finalResponse = await api.get(endpoint, { headers: { 'Daynight-Worker-Protocol': '2' } });
    expect(finalResponse.status()).toBe(200);
    const final = await finalResponse.json() as Task;
    expect(final.version).toBe(claimed.version);
    expect(final.status).toBe('in_progress');
    expect(readWorkerClaim(final.properties)).toEqual(readWorkerClaim(claimed.properties));
    expect(writes).toEqual([]);
    await info.attach('claim-profile-recovery', { contentType: 'application/json', body: JSON.stringify({
      projectId: project.id, taskId: task.id, claimId: readWorkerClaim(claimed.properties)!.claimId,
      membersReads, accessReads, unchangedTaskVersion: final.version, writes,
      cases: ['network failure', 'retry failure', 'legacy response rejection', 'independent withdrawal permission',
        'new document current-response success', 'opener draft retention', 'retry success', 'access refresh disables withdrawal'],
      boundary: 'Local production app and isolated service; injected legacy response is not evidence of the original production screenshot browser version.',
    }, null, 2) });
  } finally {
    holdAccess = false; releaseAccess?.();
    if (reader !== undefined && !reader.isClosed()) await reader.close();
    await page.unroute(membersURL); await page.unroute(accessURL);
    page.context().removeListener('request', watch);
  }
};
