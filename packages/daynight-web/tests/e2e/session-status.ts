import type { Locator, Page, TestInfo } from '@playwright/test';
import { parseUser } from '../../src/api/auth-parse';
import type { AuthenticatedAPI } from './authentication';
import { createProject, createTask, executeTask, expect } from './fixtures';
import { selectTaskList } from './project-view';
import { openStatusController } from './session-status-controller';

const rectangle = async (element: Locator) => element.evaluate(node => {
  const { x, y, width, height } = node.getBoundingClientRect();
  return { x, y, width, height };
});

export const verifySessionStatus = async (page: Page, api: AuthenticatedAPI, origin: string, info: TestInfo): Promise<void> => {
  const project = await createProject(api, { name: 'Session status annotations' });
  const identity = await api.get('/api/v1/me');
  expect(identity.status()).toBe(200);
  const caller = parseUser(await identity.json());
  const root = await createTask(api, project.id, { title: 'Session annotations across a complete collapsed chain' });
  await executeTask(api, project.id, root);
  const tasks = await Promise.all(['Working task with a deliberately long title to exercise the narrow layout', 'Question task', 'Idle task'].map(title =>
    createTask(api, project.id, { title, dependsOn: [root.id], assignedTo: caller.id })));
  const controllers: Awaited<ReturnType<typeof openStatusController>>[] = [];
  const reads: string[] = [], channels: string[] = [];
  const recordRequest = (request: import('@playwright/test').Request) => { if (new URL(request.url()).pathname.includes('/sessions/')) reads.push(new URL(request.url()).pathname); };
  const recordSocket = (socket: import('@playwright/test').WebSocket) => channels.push(new URL(socket.url()).pathname);
  page.on('request', recordRequest); page.on('websocket', recordSocket);
  const chain = page.locator(`.goal-row[data-chain-id="${root.id}"]`);
  const chainStatus = chain.locator('.goal-header > .session-status-slot .session-status-control');
  const toggle = page.locator(`#task-root-${root.id}`);
  const row = (index: number) => page.locator(`#chain-task-${root.id}-${tasks[index]!.id}`).locator('..');
  const status = (index: number) => row(index).locator('.session-status-control');
  const badge = (element: Locator) => element.locator('.session-status-annotation');
  const openProject = async () => {
    await page.goto(`/projects/${project.id}`);
    await selectTaskList(page);
    await page.getByRole('tab', { name: '任务链', exact: true }).click();
  };
  const geometries: unknown[] = [];
  try {
    for (const [index, activity] of (['working', 'waiting_input', 'idle'] as const).entries()) {
      controllers.push(await openStatusController(api, origin, tasks[index]!, activity));
    }
    await openProject();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(badge(chainStatus)).toHaveText('warning', { timeout: 15_000 });
    expect(reads.filter(path => /\/timeline|\/channel/.test(path))).toEqual([]);
    expect(channels).toEqual([]);
    await chainStatus.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(new URL(page.url()).pathname).toBe(`/projects/${project.id}`);

    for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const [index, activity] of (['working', 'waiting_input', 'idle'] as const).entries()) await controllers[index]!.update(activity);
      await expect(badge(status(0))).toHaveText('working', { timeout: 15_000 });
      await expect(badge(status(1))).toHaveText('notice', { timeout: 15_000 });
      await expect(badge(status(2))).toHaveText('warning', { timeout: 15_000 });
      const measure = async () => ({
        header: await rectangle(chain.locator('.goal-header')),
        title: await rectangle(toggle.locator('.root-title')),
        state: await rectangle(chainStatus.locator('.root-status')),
        rows: await Promise.all(tasks.map(async (_task, index) => ({ row: await rectangle(row(index)),
          title: await rectangle(row(index).locator('.root-title')), state: await rectangle(status(index).locator('.root-status')) }))),
      });
      const before = await measure();
      const visibleScreenshot = info.outputPath(`session-status-visible-${viewport.width}.png`);
      await page.screenshot({ path: visibleScreenshot, fullPage: true });
      await info.attach(`session-status-visible-${viewport.width}`, { path: visibleScreenshot, contentType: 'image/png' });
      expect(await badge(status(0)).evaluate(node => {
        const style = getComputedStyle(node);
        return { font: style.fontFamily, size: style.fontSize, style: style.fontStyle, background: style.backgroundColor, border: style.borderTopWidth };
      })).toMatchObject({ font: expect.stringContaining('Georgia'), size: '8.5px', style: 'italic', background: 'rgba(0, 0, 0, 0)', border: '0px' });
      expect((await rectangle(status(0))).height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await controllers[2]!.update('unknown');
      await expect(badge(chainStatus)).toHaveText('notice', { timeout: 15_000 });
      expect(await measure()).toEqual(before);
      await controllers[1]!.update('unknown');
      await expect(badge(chainStatus)).toHaveText('working', { timeout: 15_000 });
      expect(await measure()).toEqual(before);
      await controllers[0]!.update('unknown');
      await expect(badge(chainStatus)).toHaveCount(0, { timeout: 15_000 });
      expect(await measure()).toEqual(before);
      const screenshot = info.outputPath(`session-status-${viewport.width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await info.attach(`session-status-${viewport.width}`, { path: screenshot, contentType: 'image/png' });
      geometries.push({ viewport, before, after: await measure() });
    }
    expect(reads.filter(path => /\/timeline|\/channel/.test(path))).toEqual([]);
    expect(channels).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 1000 });
    for (const [index, activity] of (['working', 'waiting_input', 'idle'] as const).entries()) await controllers[index]!.update(activity);
    for (const index of [0, 1, 2]) {
      await expect(badge(status(index))).toHaveText(['working', 'notice', 'warning'][index]!, { timeout: 15_000 });
      if (index === 0) {
        await status(index).focus();
        await expect(page.getByRole('tooltip', { name: '会话工作中，打开 Session', exact: true })).toBeVisible();
        await page.keyboard.press('Enter');
      } else if (index === 1) {
        await status(index).scrollIntoViewIfNeeded();
        const target = await rectangle(status(index));
        const cdp = await page.context().newCDPSession(page);
        try {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height / 2 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        } finally { await cdp.detach(); }
      } else await status(index).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/tasks/${tasks[index]!.id}\\?tab=session$`));
      await expect(page.locator('.task-detail-title')).toHaveText(tasks[index]!.title);
      await expect(page.getByRole('tab', { name: 'Session', exact: true })).toHaveAttribute('aria-selected', 'true');
      await openProject();
      await expect(badge(chainStatus)).toHaveText('warning', { timeout: 15_000 });
      await chainStatus.click();
    }
    await page.locator(`#chain-task-${root.id}-${tasks[0]!.id}`).click();
    await expect(page.locator('.task-detail-dialog').getByRole('tab', { name: '概览', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    expect(await page.locator('button button, button a, a button').count()).toBe(0);
    await info.attach('session-status-evidence', { contentType: 'application/json', body: JSON.stringify({
      projectId: project.id, taskIds: tasks.map(task => task.id), sessionIds: controllers.map(controller => controller.sessionId), geometries,
      boundary: 'Production app and real isolated service with protocol Controller fixtures; no native provider execution is claimed.',
      checks: ['collapsed complete-chain aggregation', 'warning to notice to working to hidden', 'desktop and narrow stable geometry', 'current-only list reads', 'keyboard touch and mouse Session navigation', 'title opens overview'],
    }, null, 2) });
  } finally {
    page.removeListener('request', recordRequest); page.removeListener('websocket', recordSocket);
    const cleanup = await Promise.allSettled(controllers.map(controller => controller.close()));
    const errors = cleanup.filter(result => result.status === 'rejected');
    if (errors.length > 0) throw new AggregateError(errors.map(result => result.reason), 'Status Controller cleanup failed.');
    await page.setViewportSize({ width: 1600, height: 1100 });
  }
};
