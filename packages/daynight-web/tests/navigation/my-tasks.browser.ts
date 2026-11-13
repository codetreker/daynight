import { expect, test } from '@playwright/test';
import { unsupportedSessionObservation } from '../../../daynight/src/api/task-observation';

const userId = '00000000-0000-4000-8000-000000000011';
const projectId = '00000000-0000-4000-8000-000000000031';
const otherProjectId = '00000000-0000-4000-8000-000000000032';
const teamId = '00000000-0000-4000-8000-000000000041';
const goalId = '00000000-0000-4000-8000-000000000051';
const taskId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const longProject = 'ProjectWithAnUnbrokenLongName'.repeat(4);
const longTask = 'TaskWithAnUnbrokenLongName'.repeat(5);
const longGoal = 'GoalWithAnUnbrokenLongName'.repeat(5);
const project = { id: projectId, name: longProject, ownerTeam: { id: teamId, kind: 'ordinary', name: 'Team' }, executionWarningMinutes: 120, matchedTaskCount: 16 };
const observation = { ...unsupportedSessionObservation(), observation: 'observed', registration: 'not_applicable', reason: 'no_execution', error: null, observedAt: '2026-11-13T10:00:00Z', freshUntil: '2026-11-13T11:00:00Z' };
const row = (n: number) => ({ project, task: { id: taskId(n), version: '1', title: n === 1 ? longTask : `Task ${n}`, status: 'in_progress', startedAt: null, allowAgents: false, paused: false, goal: n === 1 ? { id: goalId, title: longGoal } : null }, session: observation });
const payload = { observedAt: '2026-11-13T10:00:00Z', inventoryRevision: 'a'.repeat(64), totalTaskCount: 17, totalProjectCount: 2, sessionPartial: false,
  items: [...Array.from({ length: 16 }, (_, i) => row(i + 1)), { ...row(17), project: { ...project, id: otherProjectId, name: 'Other project', matchedTaskCount: 1 } }], nextCursor: null };

for (const width of [320, 1280]) {
  test(`real overview retains layout, links and reading page at ${width}px`, async ({ page, context }) => {
    await page.setViewportSize({ width, height: 800 });
    let requests = 0, responses = 0;
    let release: (() => void) | null = null;
    await page.route('**/api/v1/me/in-progress-tasks?*', async route => {
      requests++;
      if (requests > 1) await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ json: payload, headers: { 'Daynight-User-ID': userId } });
      responses++;
    });
    await context.route('**/projects/**', route => route.fulfill({ contentType: 'text/html', body: 'Detail destination' }));
    await page.goto('/tests/navigation/my-tasks-browser.html');
    const group = page.getByRole('region', { name: `${longProject} · Team · ${projectId}` });
    await expect(group.getByText('16 in progress')).toBeVisible();
    const task = group.getByRole('link', { name: longTask });
    const goal = group.getByRole('link', { name: `View Goal: ${longGoal}` });
    await expect(task).toHaveAttribute('href', `/projects/${projectId}/tasks/${taskId(1)}`);
    await expect(goal).toHaveAttribute('href', `/projects/${projectId}/tasks/${goalId}`);
    await expect(goal).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const popupPromise = context.waitForEvent('page');
    await goal.click({ modifiers: ['Control'] });
    const popup = await popupPromise;
    await expect.poll(() => new URL(popup.url()).pathname).toBe(`/projects/${projectId}/tasks/${goalId}`);
    await popup.close();
    await page.getByLabel('Language').selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '进行中的任务' })).toBeVisible();
    await expect(group.getByRole('link', { name: `查看 Goal：${longGoal}` })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel('语言').selectOption('en');
    await group.getByRole('button', { name: 'Next' }).click();
    const secondPageTask = group.getByRole('link', { name: 'Task 16' });
    await expect(secondPageTask).toBeVisible();
    await secondPageTask.focus();
    const before = await secondPageTask.boundingBox();
    const element = await secondPageTask.elementHandle();
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => requests).toBe(2);
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    release!();
    await expect.poll(() => responses).toBe(2);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(secondPageTask).toBeVisible();
    await expect(secondPageTask).toBeFocused();
    expect(await secondPageTask.boundingBox()).toEqual(before);
    expect(await element!.evaluate(el => el === document.activeElement)).toBe(true);
  });
}
