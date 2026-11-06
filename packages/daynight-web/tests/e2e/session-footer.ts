import type { Locator, Page, TestInfo } from '@playwright/test';
import { parseUser } from '../../src/api/auth-parse';
import type { AuthenticatedAPI } from './authentication';
import { createProject, createTask, expect, type BrowserWriteExpectation } from './fixtures';
import { openFooterController } from './session-footer-controller';

const geometry = (footer: Locator) => footer.evaluate(element => {
  const box = (node: Element) => {
    const r = node.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, center: r.top + r.height / 2 };
  };
  const required = (selector: string) => {
    const node = element.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Missing footer control: ${selector}`);
    return node;
  };
  const model = required('.session-model-trigger'), label = required('.session-model-label');
  const settings = required('.session-controls-toolbar'), actions = required('.session-primary-actions');
  const activity = element.querySelector('.session-composer-activity');
  const groups = [settings, ...(activity ? [activity] : []), actions].map(box);
  const rows: number[] = [];
  for (const group of groups) if (!rows.some(center => Math.abs(center - group.center) < 2)) rows.push(group.center);
  return {
    frame: box(element), groups, rows: rows.length, activityParts: [...element.querySelectorAll('.session-activity-summary > *')].map(box), model: box(model), caret: box(required('.session-control-caret')),
    label: { width: label.clientWidth, scroll: label.scrollWidth },
    triggers: [...settings.querySelectorAll('button')].map(box),
    actions: [...actions.querySelectorAll('button')].map(box), slash: box(required('.session-command-trigger')),
    coarse: matchMedia('(pointer: coarse)').matches,
  };
});

/** Exercise production Task Session routes against a real service and controlled relay writer. */
export async function verifySessionFooter(page: Page, api: AuthenticatedAPI, origin: string, info: TestInfo, allowBrowserWrites: (entries: readonly BrowserWriteExpectation[]) => void = () => {}): Promise<void> {
  const identity = await api.get('/api/v1/me');
  expect(identity.status()).toBe(200);
  const caller = parseUser(await identity.json());
  const project = await createProject(api, { name: 'Session footer acceptance' });
  const task = await createTask(api, project.id, { title: 'Session footer layout', assignedTo: caller.id });
  const controller = await openFooterController(api, origin, task, 'idle');
  const observations: unknown[] = [];
  try {
    await page.goto(`/projects/${project.id}/tasks/${task.id}?tab=session`);
    const session = page.locator('.task-agent-session');
    const footer = session.locator('.session-composer-footer-default');
    await expect(footer).toBeVisible();
    const input = session.locator('textarea');
    await input.fill('Retain this draft across layout and native state changes.');
    const models = ['GPT-6-Astra', 'Default (recommended)', 'provider/very-long-model-identifier-with-context-window-and-deployment-suffix'];
    const activities = ['idle', 'working', 'waiting_input'] as const;
    for (const viewport of [{ width: 320, height: 640 }, { width: 375, height: 667 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
      await page.setViewportSize(viewport);
      for (const model of models) for (const activity of activities) {
        await controller.update(activity, model);
        await expect(footer.locator('.session-model-label')).toHaveText(model);
        const summary = footer.locator('.session-activity-summary [aria-live]');
        if (activity === 'idle') await expect(summary).toHaveCount(0);
        else await expect(summary).toHaveText(activity === 'working' ? 'Working' : 'Waiting for an answer');
        const measured = await geometry(footer);
        observations.push({ viewport, modelLabel: model, activity, ...measured });
        expect(measured.rows, 'Footer occupies at most three semantic rows').toBeLessThanOrEqual(3);
        if (activity === 'idle' && measured.frame.width >= 256 || measured.frame.width >= 516) {
          expect(measured.rows, 'Available container width keeps the footer on one row').toBe(1);
        }
        for (const rect of [...measured.groups, ...measured.triggers, ...measured.actions, ...measured.activityParts]) {
          expect(rect.left).toBeGreaterThanOrEqual(measured.frame.left - 1);
          expect(rect.right).toBeLessThanOrEqual(measured.frame.right + 1);
        }
        for (const controls of [measured.triggers, measured.actions]) {
          expect(Math.max(...controls.map(rect => rect.center)) - Math.min(...controls.map(rect => rect.center))).toBeLessThan(2);
          for (let i = 1; i < controls.length; i++) expect(controls[i]!.left).toBeGreaterThanOrEqual(controls[i - 1]!.right);
        }
        expect(measured.caret.width).toBeGreaterThan(0);
        expect(measured.caret.left).toBeGreaterThanOrEqual(measured.model.left);
        expect(measured.caret.right).toBeLessThanOrEqual(measured.model.right);
        if (viewport.width < 600 && model === models[2]) expect(measured.label.scroll).toBeGreaterThan(measured.label.width);
        if (measured.coarse) {
          for (const rect of [...measured.triggers, ...measured.actions]) expect(rect.height).toBeGreaterThanOrEqual(36);
          expect(measured.slash.width).toBeGreaterThanOrEqual(36);
        }
        await expect(input).toHaveValue('Retain this draft across layout and native state changes.');
      }
      const screenshot = info.outputPath(`session-footer-${viewport.width}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach(`session-footer-${viewport.width}`, { path: screenshot, contentType: 'image/png' });
    }

    await controller.update('working');
    await expect(footer.locator('.session-activity-summary [aria-live]')).toHaveText('Working');
    const model = footer.locator('.session-model-trigger');
    const permission = footer.getByRole('button', { name: 'Permissions', exact: true });
    const slash = footer.locator('.session-command-trigger');
    const interrupt = footer.getByRole('button', { name: 'Interrupt', exact: true });
    const submit = footer.getByRole('button', { name: 'Add to current turn', exact: true });
    await model.focus();
    for (const control of [permission, slash, interrupt, submit]) {
      await page.keyboard.press('Tab'); await expect(control).toBeFocused();
    }
    await expect(footer.getByRole('tooltip')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(footer.getByRole('tooltip')).toBeHidden();
    await expect(submit).toBeFocused();

    await model.click();
    await expect(session.locator('.session-controls-panel')).toBeVisible();
    await expect(session.locator('.session-controls-panel option:checked').first()).toHaveText('GPT-6-Astra');
    await page.keyboard.press('Escape');
    await expect(session.locator('.session-controls-panel')).toHaveCount(0);
    await expect(input).toBeFocused();
    await slash.click();
    await expect(session.locator('.session-command-menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(session.locator('.session-command-menu')).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Retain this draft across layout and native state changes.');

    await session.locator('.session-fullscreen-toggle').click();
    await expect(session.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'true');
    expect((await geometry(footer)).rows).toBe(1);
    await page.keyboard.press('Escape');
    await expect(session.locator('.session-fullscreen-toggle')).toHaveAttribute('aria-pressed', 'false');
    await page.setViewportSize({ width: 1280, height: 900 });
    const atContentWidth = async (target: number) => {
      // A real desktop Session can occupy a narrower panel than the page's minimum viewport width.
      for (let attempt = 0; attempt < 5; attempt++) {
        const actual = (await geometry(footer)).frame.width;
        if (Math.abs(actual - target) < 1) return;
        await session.evaluate((element, adjustment) => { element.style.width = `${element.getBoundingClientRect().width + adjustment}px`; element.style.maxWidth = '100%'; }, target - actual);
      }
      expect((await geometry(footer)).frame.width, 'Actual footer content reaches the breakpoint').toBeCloseTo(target, 0);
    };
    const assertContained = async (label: string, target: number) => {
      const measured = await geometry(footer);
      observations.push({ state: label, contentWidth: target, constrainedSessionPanel: true, ...measured });
      expect(measured.rows).toBeLessThanOrEqual(3);
      for (const rect of [...measured.groups, ...measured.triggers, ...measured.actions, ...measured.activityParts]) {
        expect(rect.left, label).toBeGreaterThanOrEqual(measured.frame.left - 1);
        expect(rect.right, label).toBeLessThanOrEqual(measured.frame.right + 1);
      }
      for (let index = 0; index < measured.groups.length; index++) for (let other = index + 1; other < measured.groups.length; other++) {
        const left = measured.groups[index]!, right = measured.groups[other]!;
        expect(left.right <= right.left + 1 || right.right <= left.left + 1 || left.bottom <= right.top + 1 || right.bottom <= left.top + 1, `${label}: semantic groups do not overlap`).toBe(true);
      }
      const controls = [...measured.triggers, ...measured.actions, ...measured.activityParts];
      for (let index = 0; index < controls.length; index++) for (let other = index + 1; other < controls.length; other++) {
        const left = controls[index]!, right = controls[other]!;
        expect(left.right <= right.left + 1 || right.right <= left.left + 1 || left.bottom <= right.top + 1 || right.bottom <= left.top + 1, `${label}: controls do not overlap across groups`).toBe(true);
      }
      expect(measured.caret.right).toBeLessThanOrEqual(measured.model.right);
    };
    const boundaries = [233, 234, 235, 255, 256, 257, 345, 346, 347, 515, 516, 517];
    await controller.update('idle', models[2]);
    await expect(footer.locator('.session-activity-summary')).toHaveCount(0);
    for (const width of boundaries) {
      await atContentWidth(width); await assertContained('idle-breakpoint', width);
      expect((await geometry(footer)).rows).toBe(width >= 234 ? 1 : 2);
    }
    const fixedTime = Date.now();
    await page.clock.setFixedTime(fixedTime);
    for (const seconds of [3599, 3600]) {
      await controller.update('waiting_input', models[2], new Date(fixedTime - seconds * 1000).toISOString());
      await expect(footer.locator('time')).toHaveText(seconds === 3599 ? '59m 59s' : '1h 00m');
      for (const width of boundaries) { await atContentWidth(width); await assertContained(`elapsed-${seconds}`, width); }
    }
    await controller.update('waiting_input', models[2], new Date(fixedTime - 3600_000).toISOString(), false);
    await expect(footer.locator('.session-activity-summary')).toHaveCount(0);
    await expect(interrupt).toBeDisabled();
    for (const width of boundaries) { await atContentWidth(width); await assertContained('waiting-status-suppressed', width); }
    const commandURL = `${origin}/api/v1/projects/${project.id}/tasks/${task.id}/sessions/${controller.sessionId}/commands`;
    allowBrowserWrites([{ method: 'POST', url: commandURL, count: 3 }]);
    // The controlled relay writer holds authorized submissions, then rejects them without executing a Provider action.
    for (const pending of ['send', 'cancel', 'command'] as const) {
      await controller.update(pending === 'cancel' ? 'working' : 'idle', models[2]);
      await expect(footer.locator('.session-model-label')).toHaveText(models[2]!);
      if (pending === 'cancel') await expect(interrupt).toBeEnabled();
      else await expect(footer.locator('.session-activity-summary')).toHaveCount(0);
      await input.fill(pending === 'command' ? '/compact' : 'Do not execute: transport layout fixture.');
      if (pending === 'command') await page.keyboard.press('Escape');
      if (pending === 'cancel') await interrupt.click();
      else await footer.locator('button[type="submit"]').click();
      const command = await controller.waitForSubmission();
      try {
        const label = pending === 'send' ? 'Awaiting provider confirmation' : pending === 'cancel' ? 'Interrupting…' : 'Executing command';
        await expect(footer.getByRole('button', { name: label, exact: true })).toBeVisible();
        for (const width of boundaries) { await atContentWidth(width); await assertContained(label, width); }
      } finally { await controller.rejectSubmission(command); }
      await expect(footer.getByRole('button', { name: /^(Awaiting provider confirmation|Interrupting…|Executing command)$/ })).toHaveCount(0);
    }
    await info.attach('session-footer-evidence', { contentType: 'application/json', body: JSON.stringify({
      projectId: project.id, taskId: task.id, sessionId: controller.sessionId, observations,
      boundary: 'Production Task Session pages and real isolated service with a protocol Controller fixture. Authorized pending submissions are held and rejected by the controlled relay writer; no native Provider or physical mobile keyboard coverage is claimed.',
    }, null, 2) });
  } finally {
    const cleanup = await controller.close();
    await info.attach('session-footer-cleanup', { contentType: 'application/json', body: JSON.stringify({ projectId: project.id, taskId: task.id, sessionId: controller.sessionId, ...cleanup }) });
  }
}
