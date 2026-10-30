import { randomUUID } from 'node:crypto';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { readWorkerClaim } from '../../src/api/task-properties';
import { attachmentDownloadUrl } from '../../src/api/client';
import { attachmentFileButton } from './attachment-tree';
import type { AuthenticatedAPI } from './authentication';
import { createProject, createTask, expect, type Task } from './fixtures';
import { selectTaskList } from './project-view';

const ownerName = 'Claim owner '.repeat(16) + 'complete';
const account = `${'account'.repeat(24)}@example.com`;
const machineName = 'Machine-'.repeat(24) + 'complete';

const expectIdentityEdges = async (heading: Locator): Promise<void> => {
  for (const selector of ['.task-claim-owner strong', '.task-claim-account', '.task-claim-execution > span:first-child']) {
    for (const edge of ['start', 'end'] as const) {
      expect(await heading.evaluate((region, { selector, edge }) => {
        const element = region.querySelector(selector)!;
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const texts: Node[] = [];
        let node: Node | null;
        while ((node = walker.nextNode()) !== null) {
          if (node.textContent!.trim() !== '' && !node.parentElement!.closest('.task-claim-label')) texts.push(node);
        }
        const text = edge === 'start' ? texts[0]! : texts.at(-1)!;
        const length = text.textContent!.length;
        const range = document.createRange();
        range.setStart(text, edge === 'start' ? 0 : length - 1);
        range.setEnd(text, edge === 'start' ? 1 : length);
        let bounds = range.getBoundingClientRect();
        let viewport = region.getBoundingClientRect();
        region.scrollTop += edge === 'start' ? bounds.top - viewport.top - 4 : bounds.bottom - viewport.bottom + 4;
        bounds = range.getBoundingClientRect(); viewport = region.getBoundingClientRect();
        return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
      }, { selector, edge }), `${selector} ${edge} remains readable by scrolling`).toBe(true);
    }
  }
};

export const verifyClaimReadingLayouts = async (page: Page, api: AuthenticatedAPI, info: TestInfo): Promise<void> => {
  const project = await createProject(api, { name: 'Claim reading allocation' });
  const task = await createTask(api, project.id, { title: 'Claim reading allocation', description: Array.from({ length: 60 }, (_, index) => `Paragraph ${index + 1}: the reading panel remains accessible.`).join('\n\n') });
  const path = `/api/v1/projects/${project.id}/tasks/${task.id}`;
  const enabled = await api.patch(path, { data: { version: task.version, allowAgents: true } });
  expect(enabled.status()).toBe(200);
  const enabledTask = await enabled.json() as Task;
  const claimId = randomUUID();
  const claimed = await api.post(`${path}/worker-claim`, { data: { version: enabledTask.version, claimId, workerId: randomUUID(), machine: { id: randomUUID(), name: machineName }, platform: 'linux', agent: 'codex', worktreeId: randomUUID() } });
  expect(claimed.status()).toBe(200);
  const current = await claimed.json() as Task;
  const attachment = await api.put(attachmentDownloadUrl(project.id, task.id, 'docs/guide.md'), { headers: { 'Content-Type': 'text/markdown' }, data: '# Claim reader\n\n' + 'The attachment remains readable.\n\n'.repeat(60) });
  expect(attachment.status()).toBe(201);
  const membersURL = `**/api/v1/projects/${project.id}/members`;
  await page.route(membersURL, async (route) => {
    const response = await api.get(`/api/v1/projects/${project.id}/members`);
    const body = await response.json() as { items: { userId: string; name: string | null; email: string | null }[] };
    const headers = { ...response.headers() }; delete headers['content-length'];
    await route.fulfill({ status: response.status(), headers, json: { ...body, items: body.items.map((member) => member.userId === readWorkerClaim(current.properties)!.userId ? { ...member, name: ownerName, email: account } : member) } });
  });
  const layouts: unknown[] = [];
  try {
    for (const state of ['active', 'released'] as const) {
      if (state === 'released') {
        const response = await api.post(`${path}/worker-claim/release`, { data: { version: current.version, claimId, stoppedConfirmed: true } });
        expect(response.status()).toBe(200);
      }
      for (const mode of ['dialog', 'page'] as const) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        if (mode === 'page') await page.goto(`/projects/${project.id}/tasks/${task.id}`);
        else {
          await page.goto(`/projects/${project.id}`); await selectTaskList(page);
          await page.getByRole('tab', { name: /^(独立任务|Standalone tasks)$/, exact: true }).click();
          await page.locator(`#standalone-task-${task.id}`).click();
        }
        const root = page.locator(mode === 'page' ? '.task-detail-page' : '.task-detail-dialog');
        const heading = root.getByRole('region', { name: /^(任务设置与认领|Task settings and claim)$/, exact: true });
        await expect(heading.locator('.task-claim-owner strong')).toHaveText(ownerName);
        await expect(heading.locator('.task-claim-account')).toHaveText(account);
        for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 800 }, { width: 320, height: 240 }]) {
          await page.setViewportSize(viewport);
          for (const fullscreen of [false, true]) {
            if (fullscreen) await root.locator('.task-detail-fullscreen-toggle').click();
            await root.getByRole('tab', { name: /^(概览|Overview)$/, exact: true }).click();
            const overview = root.locator('.task-detail-panel-overview');
            await expect.poll(async () => (await overview.boundingBox())!.height).toBeGreaterThanOrEqual(32);
            const overviewBounds = await overview.boundingBox();
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
            await expectIdentityEdges(heading);
            await heading.focus(); await page.keyboard.press('Home'); await page.keyboard.press('End');
            if (await heading.evaluate((element) => element.scrollHeight > element.clientHeight + 1)) {
              await heading.evaluate((element) => { element.scrollTop = 0; });
              const bounds = (await heading.boundingBox())!;
              await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
              await page.mouse.wheel(0, 250);
              await expect.poll(() => heading.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            }
            const withdraw = heading.getByRole('button', { name: /^(强制撤回|Force withdraw)$/, exact: true });
            await withdraw.focus();
            await expect.poll(() => withdraw.evaluate((element) => { const bounds = element.getBoundingClientRect(), region = element.closest('.task-detail-heading')!.getBoundingClientRect(); return bounds.top >= region.top - 1 && bounds.bottom <= region.bottom + 1; })).toBe(true);
            await root.getByRole('tab', { name: /^(附件|Attachments)$/, exact: true }).click();
            await (await attachmentFileButton(root, 'docs/guide.md')).click();
            const preview = root.locator('.attachment-preview-body');
            await expect(preview.locator('.attachment-markdown')).toContainText('The attachment remains readable.');
            await info.attach('claim-reading-allocation', { contentType: 'application/json', body: JSON.stringify({ state, mode, viewport, fullscreen, allocation: await page.evaluate(() => {
              const selectors = ['.auth-shell', '.task-detail-page-container', '.task-detail-page', '.task-detail-dialog', '.task-detail-page-topbar', '.task-detail-header', '.task-detail-body', '.task-detail-heading', '.task-detail-panels', '.task-detail-tabs', '.task-detail-panel-attachments', '.attachment-split', '.attachment-preview-pane', '.attachment-preview-header', '.attachment-preview-body'];
              return { locale: document.documentElement.lang, elements: selectors.map((selector) => {
                const element = document.querySelector<HTMLElement>(selector);
                if (element === null) return { selector, missing: true };
                const bounds = element.getBoundingClientRect(), style = getComputedStyle(element);
                return { selector, height: bounds.height, top: bounds.top, bottom: bounds.bottom, client: element.clientHeight, scroll: element.scrollHeight, overflow: style.overflowY, flex: style.flex, minHeight: style.minHeight, maxHeight: style.maxHeight, display: style.display };
              }) };
            }) }, null, 2) });
            await expect.poll(async () => (await preview.boundingBox())!.height).toBeGreaterThanOrEqual(18);
            await preview.evaluate((element) => { element.scrollTop = element.scrollHeight; });
            await expect.poll(() => preview.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
            layouts.push({ state, mode, viewport, fullscreen, heading: await heading.boundingBox(), overview: overviewBounds, preview: await preview.boundingBox() });
            if (viewport.height === 240) {
              const screenshot = info.outputPath(`claim-reading-${state}-${mode}-${fullscreen}.png`);
              await page.screenshot({ path: screenshot }); await info.attach('claim-reading-layout', { path: screenshot, contentType: 'image/png' });
            }
            if (fullscreen) await root.locator('.task-detail-fullscreen-toggle').click();
          }
        }
      }
    }
    await info.attach('claim-reading-layouts', { contentType: 'application/json', body: JSON.stringify(layouts, null, 2) });
  } catch (error) {
    const screenshot = info.outputPath('claim-reading-failure.png');
    await page.screenshot({ path: screenshot });
    await info.attach('claim-reading-failure', { path: screenshot, contentType: 'image/png' });
    throw error;
  } finally { await page.unroute(membersURL); }
};
