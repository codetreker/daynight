import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = 'be34edc4-af6d-4b40-a33f-55d6c18b7e6a';
const time = '2026-10-20T09:00:00Z';
const key = `daynight.selectedTeam:${userId}`;
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
type State = { role: 'admin' | 'member'; name: string; version: number; exists: boolean; refusal: string | null; lost: boolean; holdRead?: { started: () => void; wait: Promise<void> }; writes: { method: string; body: Record<string, unknown> }[] };
const install = async (page: Page): Promise<State> => {
  const state: State = { role: 'admin', name: 'Alpha', version: 1, exists: true, refusal: null, lost: false, writes: [] };
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : state.name, version: state.version, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: state.role, version: 1, createdAt: time, updatedAt: time } });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const headers = { 'Daynight-User-ID': userId };
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ json: body, status, headers: { ...headers, ...extra } });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/teams' && method === 'GET') return send({ items: state.exists ? [team(teamId)] : [], nextCursor: null });
    if ((path === '/api/v1/teams' && method === 'POST') || (path === `/api/v1/teams/${teamId}` && (method === 'PATCH' || method === 'DELETE'))) {
      const body = request.postDataJSON() as Record<string, unknown>; state.writes.push({ method, body });
      if (state.refusal) return send(error(state.refusal), 409);
      if (method === 'POST') { state.exists = true; state.name = String(body.name); state.version = 1; }
      if (method === 'PATCH') { state.name = String(body.name); state.version++; }
      if (method === 'DELETE') state.exists = false;
      if (state.lost) return route.abort('failed');
      if (method === 'DELETE') return send({ teamId, deleted: true });
      return send(team(teamId), method === 'POST' ? 201 : 200, method === 'POST' ? { Location: `/api/v1/teams/${teamId}` } : {});
    }
    if (path === `/api/v1/teams/${personalId}`) return send(team(personalId));
    if (path === `/api/v1/teams/${teamId}`) {
      const hold = state.holdRead; delete state.holdRead;
      if (hold) { hold.started(); await hold.wait; }
      return state.exists ? send(team(teamId)) : send(error('not_found'), 404);
    }
    return send(error('not_found'), 404);
  });
  return state;
};
const selected = (page: Page) => page.evaluate((k) => localStorage.getItem(k), key);
const openCreate = async (page: Page) => { await page.locator('.team-selector .team-switch').click(); await page.getByRole('menuitem', { name: 'Create Team', exact: true }).click(); };
const settings = async (page: Page) => { await page.getByRole('link', { name: 'Team settings' }).click(); await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible(); };

test('copies the displayed Team ID with accessible feedback and responsive layout', async ({ page, context }, testInfo) => {
  const api = await install(page); api.name = 'AI Native Studio';
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const role of ['admin', 'member'] as const) {
    api.role = role;
    for (const width of [1280, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/teams/${teamId}/settings`);
      for (const [locale, label] of [['en', 'Copy Team ID'], ['zh-CN', '复制 Team ID']] as const) {
        await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
        const button = page.getByRole('button', { name: label });
        const text = page.locator('.team-settings-id span');
        await expect(text).toHaveText(teamId);
        await expect(button).toHaveAttribute('title', label);
        const textBox = await text.boundingBox(), buttonBox = await button.boundingBox();
        if (!textBox || !buttonBox) throw new Error('ID or copy button is not visible');
        expect(textBox.x + textBox.width <= buttonBox.x || textBox.y + textBox.height <= buttonBox.y).toBe(true);
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (Math.abs(textBox.y - buttonBox.y) < 10) expect(Math.abs(textBox.y + textBox.height / 2 - buttonBox.y - buttonBox.height / 2)).toBeLessThanOrEqual(1);
        await button.focus(); await expect(button).toBeFocused();
        expect(await button.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
        await page.keyboard.press(locale === 'en' ? 'Enter' : 'Space');
        await expect(page.getByRole('status').filter({ hasText: locale === 'en' ? 'Copied' : '已复制' })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(teamId);
        await page.screenshot({ path: testInfo.outputPath(`copy-${role}-${width}-${locale}.png`) });
      }
    }
  }
  expect(api.writes).toHaveLength(0);
});

test('copy errors and a pending write retain keyboard focus and permit retry', async ({ page }) => {
  const api = await install(page); await page.goto(`/teams/${teamId}/settings`);
  const button = page.getByRole('button', { name: 'Copy Team ID' }); await expect(button).toBeVisible();
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
  await button.click(); await expect(page.getByRole('alert')).toContainText('Select and copy the Team ID manually');
  await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }); });
  await button.click(); await expect(page.getByRole('alert')).toContainText('Select and copy the Team ID manually');
  await page.evaluate(() => {
    const state = window as unknown as { copyCalls: number; finishCopy: () => void };
    state.copyCalls = 0;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => { state.copyCalls++; return new Promise<void>(resolve => { state.finishCopy = resolve; }); } } });
  });
  await page.getByRole('button', { name: 'Edit', exact: true }).focus();
  await page.keyboard.press('Tab'); await expect(button).toBeFocused();
  await page.keyboard.press('Enter'); await expect(button).toHaveAttribute('aria-disabled', 'true');
  await expect(button).toBeFocused(); await page.keyboard.press('Space');
  expect(await page.evaluate(() => (window as unknown as { copyCalls: number }).copyCalls)).toBe(1);
  await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  await expect(button).toBeFocused(); await expect(button).toHaveAttribute('aria-disabled', 'false');
  expect(api.writes).toHaveLength(0);
});

test('Team name and edit action remain aligned and readable across viewport sizes', async ({ page }, testInfo) => {
  const api = await install(page);
  api.name = 'AI Native Studio';
  const centerDifferences: number[] = [];
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/teams/${teamId}/settings`);
    for (const [locale, label] of [['en', 'Edit'], ['zh-CN', '修改']] as const) {
      await page.getByRole('combobox', { name: '语言 / Language' }).selectOption(locale);
      const name = page.locator('.team-settings-name span');
      const edit = page.getByRole('button', { name: label, exact: true });
      await expect(name).toHaveText(api.name);
      const nameBox = await name.boundingBox(), editBox = await edit.boundingBox();
      expect(nameBox).not.toBeNull(); expect(editBox).not.toBeNull();
      if (!nameBox || !editBox) throw new Error('Name or edit action is not visible');
      const centerDifference = Math.abs(nameBox.y + nameBox.height / 2 - editBox.y - editBox.height / 2);
      centerDifferences.push(centerDifference);
      console.log(JSON.stringify({ width, locale, nameBox, editBox, centerDifference }));
      await page.screenshot({ path: testInfo.outputPath(`team-${width}-${locale}.png`) });
      expect(nameBox.x + nameBox.width).toBeLessThan(editBox.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  expect(Math.max(...centerDifferences)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: '修改', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog').getByLabel('Team 名称')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '修改', exact: true })).toBeFocused();
  expect(api.writes).toHaveLength(0);
});

test('long and whitespace-containing Team names remain selectable without overlap or overflow', async ({ page }, testInfo) => {
  const api = await install(page);
  for (const name of ['A'.repeat(300), '  First line\nSecond line  ']) {
    api.name = name;
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto(`/teams/${teamId}/settings`);
    const text = page.locator('.team-settings-name span');
    const edit = page.getByRole('button', { name: 'Edit', exact: true });
    await expect.poll(() => text.textContent()).toBe(name);
    const nameBox = await text.boundingBox(), editBox = await edit.boundingBox();
    expect(nameBox).not.toBeNull(); expect(editBox).not.toBeNull();
    if (!nameBox || !editBox) throw new Error('Name or edit action is not visible');
    expect(nameBox.x + nameBox.width <= editBox.x || nameBox.y + nameBox.height <= editBox.y).toBe(true);
    expect(editBox.x + editBox.width).toBeLessThanOrEqual(320);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await text.evaluate((element) => {
      const range = document.createRange(); range.selectNodeContents(element);
      const rects = Array.from(range.getClientRects());
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor), bounds = ancestor.getBoundingClientRect();
        for (const rect of rects) {
          if (['hidden', 'clip'].includes(style.overflowX) && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) return false;
          if (['hidden', 'clip'].includes(style.overflowY) && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) return false;
        }
      }
      return element.scrollWidth <= element.clientWidth && element.scrollHeight <= element.clientHeight;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(name.startsWith('A') ? 'long-name.png' : 'whitespace-name.png'), fullPage: true });
    for (const [selector, expected] of [['.team-settings-name span', name], ['.team-settings-id', teamId]] as const) {
      expect(await page.locator(selector).evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
        return selection?.toString();
      })).toBe(expected);
    }
  }
});

test('creates, renames and typed-deletes a Team, preserving raw input and browser preference', async ({ page }) => {
  const api = await install(page); api.exists = false;
  await page.goto('/projects'); await openCreate(page);
  const create = page.getByRole('dialog');
  await create.getByLabel('Team name').fill('  Alpha\nTeam  ');
  await create.getByRole('button', { name: 'Create Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Alpha Team', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect.poll(() => selected(page)).toBe(teamId);
  expect(api.writes[0]).toEqual({ method: 'POST', body: { name: '  Alpha\nTeam  ', expectedUserId: userId } });
  await settings(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Team name').fill('  Renamed\nTeam  ');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  expect(api.writes[1]).toEqual({ method: 'PATCH', body: { name: '  Renamed\nTeam  ', version: 1, expectedUserId: userId } });
  await page.getByRole('button', { name: 'Delete Team' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Enter the Team name to confirm').fill('wrong');
  await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('does not match');
  expect(api.writes).toHaveLength(2);
  await dialog.getByLabel('Enter the Team name to confirm').fill('  Renamed\nTeam  ');
  await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  await expect.poll(() => selected(page)).toBe(personalId);
  expect(api.writes[2]).toEqual({ method: 'DELETE', body: { name: '  Renamed\nTeam  ', version: 2, expectedUserId: userId } });
});

test('cancel and Escape submit nothing; dialogs retain focus on narrow screens in both languages', async ({ page }) => {
  const api = await install(page); await page.goto('/projects');
  await openCreate(page); const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Team name')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
  await openCreate(page); await dialog.getByRole('button', { name: 'Cancel' }).click(); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
  await page.setViewportSize({ width: 375, height: 667 });
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  const toggle = page.getByRole('button', { name: /展开侧栏/ });
  await toggle.click(); await page.locator('.team-selector .team-switch').click(); await page.getByRole('menuitem', { name: '创建 Team', exact: true }).click();
  await expect(dialog.getByLabel('Team 名称')).toBeFocused();
  await expect(dialog.getByRole('combobox', { name: '语言 / Language' })).toHaveCount(0);
  await expect(dialog.getByRole('heading', { name: '创建 Team' })).toBeVisible();
  await expect(dialog.getByLabel('Team 名称')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
});

test('rename dialog restores focus, discards drafts and fits long text in both languages', async ({ page }) => {
  const api = await install(page); api.name = 'A'.repeat(300);
  await page.setViewportSize({ width: 375, height: 667 }); await page.goto(`/teams/${teamId}/settings`);
  const edit = page.getByRole('button', { name: 'Edit', exact: true }); await expect(edit).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await edit.click(); const dialog = page.getByRole('dialog'), name = dialog.getByLabel('Team name');
  await expect(name).toBeFocused(); await name.fill('Draft');
  await page.keyboard.press('Shift+Tab'); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(edit).toBeFocused();
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await page.getByRole('button', { name: '修改', exact: true }).click();
  await expect(dialog.getByLabel('Team 名称')).toHaveValue('A'.repeat(300));
  await expect(dialog.getByRole('combobox', { name: '语言 / Language' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await dialog.getByRole('button', { name: '取消' }).click(); await expect(dialog).toHaveCount(0); expect(api.writes).toHaveLength(0);
});

test('nonempty refusal and lost response remain distinct, with no automatic replay', async ({ page }) => {
  const api = await install(page); await page.goto(`/teams/${teamId}/settings`);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  api.refusal = 'team_not_empty';
  await page.getByRole('button', { name: 'Delete Team' }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('still has projects'); expect(api.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  api.refusal = null; api.lost = true;
  await page.getByRole('button', { name: 'Delete Team' }).click();
  await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main').getByText('This Team is unavailable or you do not have access.')).toBeVisible();
  await expect(page.getByRole('alert').last()).toContainText('result is unknown');
  expect(api.writes).toHaveLength(2); await expect(page.getByRole('button', { name: 'Delete Team' })).toHaveCount(0);
});


test('Personal settings remain read-only, and a version conflict requires a fresh typed name', async ({ page }) => {
  const api = await install(page);
  await page.goto(`/teams/${personalId}/settings`);
  await expect(page.getByRole('main').getByText('Personal', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete Team' })).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  await page.goto(`/teams/${teamId}/settings`);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Delete Team' }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha');
  api.name = 'New name'; api.version = 2; api.refusal = 'version_conflict';
  await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByText('New name')).toBeVisible();
  await expect(dialog.getByLabel('Enter the Team name to confirm')).toHaveValue('');
  expect(api.writes).toHaveLength(1);
  api.refusal = null;
  await dialog.getByLabel('Enter the Team name to confirm').fill('New name');
  await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  expect(api.writes[1]).toEqual({ method: 'DELETE', body: { name: 'New name', version: 2, expectedUserId: userId } });
});


test('Escape restores focus after the delete dialog waits for a fresh Team read', async ({ page }) => {
  const api = await install(page); await page.goto(`/teams/${teamId}/settings`);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  api.holdRead = { started: started.resolve, wait: finish.promise };
  const opener = page.getByRole('button', { name: 'Delete Team' });
  await opener.click(); await started.promise;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  finish.resolve();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Enter the Team name to confirm')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  expect(api.writes).toHaveLength(0);
});
