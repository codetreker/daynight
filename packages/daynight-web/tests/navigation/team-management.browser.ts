import { expect, test, type Page, type Route } from '@playwright/test';
import { expectCopyButtonSkin, expectDisabledCopyHover } from './copy-button-assertions';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = 'be34edc4-af6d-4b40-a33f-55d6c18b7e6a';
const time = '2026-10-20T09:00:00Z';
const key = `daynight.selectedTeam:${userId}`;
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
type State = { role: 'admin' | 'member'; name: string; version: number; exists: boolean; refusal: string | null; lost: boolean; nested: boolean; settingsWrites: Record<string, unknown>[]; holdRead?: { started: () => void; wait: Promise<void> }; writes: { method: string; body: Record<string, unknown> }[] };
const install = async (page: Page): Promise<State> => {
  const state: State = { role: 'admin', name: 'Alpha', version: 1, exists: true, refusal: null, lost: false, nested: false, settingsWrites: [], writes: [] };
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : state.name, version: state.version, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: state.role, version: 1, createdAt: time, updatedAt: time } });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const headers = { 'Daynight-User-ID': userId };
    const send = (body: unknown, status = 200, extra: Record<string, string> = {}) => route.fulfill({ json: body, status, headers: { ...headers, ...extra } });
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}/settings` || path === `/api/v1/teams/${personalId}/settings`) {
      if (method === 'PATCH') {
        const body = request.postDataJSON() as Record<string, unknown>;
        state.settingsWrites.push(body); state.nested = body.allowNestedSubtask === true; state.version++;
      }
      return send({ version: state.version, allowNestedSubtask: state.nested });
    }
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
const expandDelete = async (page: Page) => {
  const details = page.locator('details.team-delete');
  await expect(details).toBeVisible();
  if (await details.getAttribute('open') === null) await details.locator('summary').click();
};
const selected = (page: Page) => page.evaluate((k) => localStorage.getItem(k), key);
const openCreate = async (page: Page) => { await page.locator('.team-selector .team-switch').click(); await page.getByRole('menuitem', { name: 'Create Team', exact: true }).click(); };
const settings = async (page: Page) => { await page.getByRole('link', { name: 'Team settings' }).click(); await expect(page.getByRole('heading', { name: 'Team settings' })).toBeVisible(); };

test('nested subtask settings support keyboard and narrow layouts for administrators, members and Personal owners', async ({ page }) => {
  const api = await install(page);
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/teams/${teamId}/settings`);
    const toggle = page.getByRole('switch', { name: 'Allow nested subtasks' });
    await expect(toggle).toHaveAttribute('aria-checked', String(api.nested));
    await toggle.focus(); await expect(toggle).toBeFocused();
    expect(await toggle.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', String(!api.nested));
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(toggle).toHaveAttribute('aria-checked', String(api.nested));
    await toggle.focus(); await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect.poll(() => api.settingsWrites.length).toBe(width === 1280 ? 1 : 2);
    await expect(toggle).toHaveAttribute('aria-checked', String(api.nested));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const bounds = await toggle.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
  }
  expect(api.settingsWrites).toEqual([
    { version: 1, expectedUserId: userId, allowNestedSubtask: true },
    { version: 2, expectedUserId: userId, allowNestedSubtask: false },
  ]);
  api.role = 'member'; await page.goto(`/teams/${teamId}/settings`);
  await expect(page.getByRole('switch', { name: 'Allow nested subtasks' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toHaveCount(0);
  api.role = 'admin'; await page.goto(`/teams/${personalId}/settings`);
  await expect(page.getByRole('switch', { name: 'Allow nested subtasks' })).toBeEnabled();
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
  await expect(page.getByRole('switch', { name: '允许嵌套子任务' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const outcome of ['confirmed', 'unknown'] as const) {
  test(`late settings read cannot overwrite a ${outcome} save`, async ({ page }) => {
    await install(page);
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let reads = 0, version = 7, allowed = false;
    const writes: Record<string, unknown>[] = [];
    await page.route(`**/api/v1/teams/${teamId}/settings`, async route => {
      const request = route.request();
      if (request.method() === 'GET') {
        reads++;
        if (reads === 2) {
          started.resolve(); await release.promise;
          await route.fulfill({ json: { version: 7, allowNestedSubtask: false }, headers: { 'Daynight-User-ID': userId } }).catch(() => {});
          return;
        }
        return route.fulfill({ json: { version, allowNestedSubtask: allowed }, headers: { 'Daynight-User-ID': userId } });
      }
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push(body); version++; allowed = body.allowNestedSubtask === true;
      if (outcome === 'unknown') return route.abort('failed');
      return route.fulfill({ json: { version, allowNestedSubtask: allowed }, headers: { 'Daynight-User-ID': userId } });
    });
    await page.goto(`/teams/${teamId}/settings`);
    const toggle = page.getByRole('switch', { name: 'Allow nested subtasks' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false'); await toggle.click();
    await page.evaluate(() => {
      let focused = false;
      Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => focused });
      window.dispatchEvent(new Event('blur')); focused = true; window.dispatchEvent(new Event('focus'));
    });
    await started.promise;
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    if (outcome === 'unknown') await expect(page.getByText(/save result is unknown/)).toBeVisible();
    else await expect(page.getByText('Saved: On')).toBeVisible();
    release.resolve();
    if (outcome === 'unknown') {
      await expect(toggle).toBeDisabled();
      await expect(page.getByText(/save result is unknown/)).toBeVisible();
      expect(reads).toBe(2); expect(writes).toHaveLength(1);
      await page.getByRole('button', { name: 'Check current state' }).click();
      await expect(page.getByText('Saved: On')).toBeVisible(); await expect(toggle).toBeEnabled();
      expect(reads).toBe(3); expect(writes).toHaveLength(1);
    } else {
      await expect(toggle).toHaveAttribute('aria-checked', 'true');
      await toggle.click(); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => writes.length).toBe(2);
      expect(writes[1]).toEqual({ version: 8, expectedUserId: userId, allowNestedSubtask: false });
    }
  });
}

test('copies the displayed Team ID with accessible feedback and responsive layout', async ({ page, context }, testInfo) => {
  const api = await install(page); api.name = 'AI Native Studio';
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  for (const role of ['admin', 'member'] as const) {
    api.role = role;
    for (const width of [1440, 390, 320]) {
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
        await expectCopyButtonSkin(page, button);
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
  await expectDisabledCopyHover(page, button);
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

test('delete disclosure supports keyboard, locale, reload and narrow layouts without requests', async ({ page }) => {
  const api = await install(page); api.name = 'A'.repeat(300);
  let requests = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/v1/')) requests++; });
  for (const width of [1280, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/teams/${teamId}/settings`);
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
    const details = page.locator('details.team-delete'), summary = details.locator('summary'), button = details.locator('button');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(button).toBeHidden();
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const before = requests;
    await summary.focus(); await expect(summary).toBeFocused();
    expect(await summary.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
    await page.keyboard.press('Enter'); await expect(details).toHaveAttribute('open', ''); await expect(button).toBeVisible();
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('zh-CN');
    await expect(summary).toContainText('删除 Team'); await expect(details).toHaveAttribute('open', '');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await summary.focus(); await page.keyboard.press('Space');
    await expect(details).not.toHaveAttribute('open', ''); await expect(button).toBeHidden();
    await page.keyboard.press('Tab'); await expect(button).not.toBeFocused();
    expect(requests).toBe(before); expect(api.writes).toHaveLength(0);
    await page.reload(); await expect(page.locator('details.team-delete')).not.toHaveAttribute('open', '');
    await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
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
  await expandDelete(page); await page.locator('details.team-delete button').click();
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
  const toggle = page.getByRole('button', { name: /打开导航/ });
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
  await expandDelete(page); await page.locator('details.team-delete button').click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('still has projects'); expect(api.writes).toHaveLength(1);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  api.refusal = null; api.lost = true;
  await expandDelete(page); await page.locator('details.team-delete button').click();
  await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Check current state' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('main').getByText('This Team is unavailable or you do not have access.')).toBeVisible();
  await expect(page.getByRole('alert').last()).toContainText('result is unknown');
  expect(api.writes).toHaveLength(2); await expect(page.locator('details.team-delete button')).toHaveCount(0);
});


test('Personal settings remain read-only, and a version conflict requires a fresh typed name', async ({ page }) => {
  const api = await install(page);
  await page.goto(`/teams/${personalId}/settings`);
  await expect(page.getByRole('main').getByText('Personal', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
  await expandDelete(page); await expect(page.locator('details.team-delete button')).toBeDisabled();
  expect(api.writes).toHaveLength(0);
  await page.goto(`/teams/${teamId}/settings`);
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await expandDelete(page); await page.locator('details.team-delete button').click(); const dialog = page.getByRole('dialog');
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
  await expandDelete(page); const opener = page.locator('details.team-delete button');
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
