import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const otherProfile = { ...profile, id: '00000000-0000-4000-8000-000000000002', name: 'Bob' };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
type Gate = { started: () => void; wait: Promise<void> };
type State = { profile: typeof profile; exists: boolean; lost: boolean; holdDetail: Gate | null; holdDelete: Gate | null; writes: number; details: number; meReads: number };
const install = async (page: Page): Promise<State> => {
  const state: State = { profile, exists: true, lost: false, holdDetail: null, holdDelete: null, writes: 0, details: 0, meReads: 0 };
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : 'Alpha', version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId: state.profile.id, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers: { 'Daynight-User-ID': state.profile.id } });
    if (path === '/api/v1/me') { state.meReads++; return send(state.profile); }
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/teams') return send({ items: state.exists ? [team(teamId)] : [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team(personalId));
    if (path === `/api/v1/teams/${teamId}` && method === 'PATCH') {
      state.writes++;
      if (state.lost) return route.abort('failed');
      return send(team(teamId));
    }
    if (path === `/api/v1/teams/${teamId}` && method === 'DELETE') {
      state.writes++; state.exists = false;
      if (state.lost) return route.abort('failed');
      const gate = state.holdDelete; state.holdDelete = null; if (gate) { gate.started(); await gate.wait; }
      return send({ teamId, deleted: true });
    }
    if (path === `/api/v1/teams/${teamId}`) { state.details++; const gate = state.holdDetail; state.holdDetail = null; if (gate) { gate.started(); await gate.wait; } return state.exists ? send(team(teamId)) : send(error('not_found'), 404); }
    return send(error('not_found'), 404);
  });
  return state;
};
const start = async (page: Page) => { await page.goto(`/teams/${teamId}/settings`); await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible(); };
const openDelete = async (page: Page) => { await page.getByRole('button', { name: 'Delete Team' }).click(); const dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Enter the Team name to confirm')).toBeVisible(); return dialog; };
const foreground = async (page: Page, state: State) => {
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('about:blank');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const meReads = state.meReads;
  await page.bringToFront();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(state.meReads).toBe(meReads);
  return { other };
};

test('retains a settings draft and typed confirmation across foreground resource checks', async ({ page }) => {
  const state = await install(page); await start(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Team name').fill('Unsubmitted draft');
  const first = await foreground(page, state);
  await expect(page.getByRole('dialog').getByLabel('Team name')).toHaveValue('Unsubmitted draft'); await first.other.close();
  await page.keyboard.press('Escape');
  const dialog = await openDelete(page);
  const name = dialog.getByLabel('Enter the Team name to confirm'); await name.fill('Al');
  const second = await foreground(page, state);
  const backdrop = page.locator('.auth-modal-backdrop');
  await expect(backdrop).toBeVisible();
  await expect(name).toBeFocused();
  await expect(name).toHaveValue('Al');
  await expect(name).toHaveValue('Al'); await expect(name).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.writes).toBe(0); await second.other.close();
});

test('preserves unknown through foreground resource checks without replay', async ({ page }) => {
  const state = await install(page); await start(page); state.lost = true;
  const dialog = await openDelete(page); await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  const check = await foreground(page, state);
  await expect(page.getByRole('alert').filter({ hasText: 'result is unknown' })).toBeVisible();
  expect(state.writes).toBe(1); await expect(page.getByRole('button', { name: 'Delete Team' })).toHaveCount(0);
  await check.other.close();
});

test('preserves an unknown rename across foreground checks and closing the dialog', async ({ page }) => {
  const state = await install(page); await start(page); state.lost = true;
  const edit = page.getByRole('button', { name: 'Edit', exact: true }); await edit.click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Team name').fill('New name');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  const check = await foreground(page, state);
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(edit).toBeDisabled(); expect(state.writes).toBe(1); await check.other.close();
});

test('does not navigate on a 404 while the committed delete receipt is delayed', async ({ page }) => {
  const state = await install(page); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); state.holdDelete = { started: started.resolve, wait: finish.promise };
  const dialog = await openDelete(page); await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click(); await started.promise;
  const previousReads = state.details;
  const check = await foreground(page, state);
  await expect.poll(() => state.details).toBeGreaterThan(previousReads);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/teams/${teamId}/settings`);
  expect(state.writes).toBe(1);
  finish.resolve();
  await expect(page.locator('.project-list-information').filter({ has: page.getByText('Personal', { exact: true }) }).getByRole('heading', { name: 'Projects', exact: true })).toBeVisible();
  expect(state.writes).toBe(1); await check.other.close();
});


test('retains the create dialog input on foreground return', async ({ page }) => {
  const state = await install(page); await page.goto('/projects');
  await page.locator('.team-selector .team-switch').click(); await page.getByRole('menuitem', { name: 'Create Team', exact: true }).click();
  const backdrop = page.locator('.auth-modal-backdrop'), dialog = page.getByRole('dialog'), name = dialog.getByLabel('Team name');
  await name.fill('Unsubmitted Team');
  await name.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(2, 8); });
  const before = await name.evaluate((element: HTMLTextAreaElement) => ({ start: element.selectionStart, end: element.selectionEnd, box: element.getBoundingClientRect().toJSON() }));
  const check = await foreground(page, state);
  await expect(backdrop).toBeVisible(); await expect(name).toBeFocused();
  expect(await name.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([before.start, before.end]);
  expect(await name.boundingBox()).toMatchObject({ x: before.box.x, y: before.box.y, width: before.box.width, height: before.box.height });
  await expect(name).toHaveValue('Unsubmitted Team'); await expect(name).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.writes).toBe(0); await check.other.close();
});

test('keeps the narrow navigation and focus during foreground checks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await install(page); await page.goto('/projects');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  const drawer = page.getByRole('dialog', { name: 'Workspace navigation' });
  const link = drawer.getByRole('link', { name: 'Projects' });
  await link.focus();
  const handle = await drawer.elementHandle();
  const box = await drawer.boundingBox();
  const check = await foreground(page, state);
  expect(await drawer.evaluate((element, original) => element === original, handle)).toBe(true);
  await expect(drawer).toBeVisible(); await expect(link).toBeFocused();
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
  expect(await page.evaluate(() => document.body.style.overflow)).toBe('hidden');
  expect(await drawer.boundingBox()).toEqual(box);
  await expect(drawer).toBeVisible(); await expect(link).toBeFocused();
  await check.other.close();
});

test('keeps the Chinese narrow create dialog and selection during foreground checks', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  const state = await install(page); await page.goto('/projects');
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await page.locator('.team-selector .team-switch').click();
  await page.getByRole('menuitem', { name: '创建 Team', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '创建 Team' });
  const name = dialog.getByLabel('Team 名称');
  await name.fill('未提交草稿');
  await name.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(1, 3); });
  const handle = await dialog.elementHandle(); const box = await dialog.boundingBox();
  const check = await foreground(page, state);
  expect(await dialog.evaluate((element, original) => element === original, handle)).toBe(true);
  await expect(dialog).toBeVisible(); await expect(name).toBeFocused();
  expect(await name.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([1, 3]);
  expect(await dialog.boundingBox()).toEqual(box);
  await expect(name).toHaveValue('未提交草稿'); await expect(name).toBeFocused();
  expect(state.writes).toBe(0); await check.other.close();
});


test('retains the editor while the same Team is reread on foreground return', async ({ page }) => {
  const state = await install(page); await start(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const dialog = page.getByRole('dialog'), name = dialog.getByLabel('Team name');
  await name.fill('Unsubmitted draft');
  await name.evaluate((element: HTMLTextAreaElement) => { element.focus(); element.setSelectionRange(2, 8); });
  const original = await dialog.elementHandle(), box = await dialog.boundingBox();
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  state.holdDetail = { started: started.resolve, wait: finish.promise };
  const check = await foreground(page, state);
  await expect(name).toBeFocused(); await started.promise;
  expect(await dialog.evaluate((element, node) => element === node, original)).toBe(true);
  await expect(dialog).toBeVisible(); await expect(name).toBeFocused();
  expect(await name.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([2, 8]);
  expect(await dialog.boundingBox()).toEqual(box);
  finish.resolve(); await expect(name).toHaveValue('Unsubmitted draft'); await expect(name).toBeFocused();
  expect(state.writes).toBe(0); await check.other.close();
});


type ClipboardProbe = { calls: string[]; resolve?: () => void };
const installClipboardProbe = async (page: Page) => {
  await page.addInitScript(() => {
    const probe: ClipboardProbe = { calls: [] };
    (window as unknown as { clipboardProbe: ClipboardProbe }).clipboardProbe = probe;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (value: string) => {
      probe.calls.push(value);
      return new Promise<void>((resolve) => { probe.resolve = resolve; });
    } } });
  });
};
const clipboardCalls = (page: Page) => page.evaluate(() => (window as unknown as { clipboardProbe: ClipboardProbe }).clipboardProbe.calls);
const resolveClipboard = (page: Page) => page.evaluate(() => (window as unknown as { clipboardProbe: ClipboardProbe }).clipboardProbe.resolve?.());

test('retains a pending Team ID copy through a foreground return', async ({ page }) => {
  await installClipboardProbe(page);
  const state = await install(page); await start(page);
  const copy = page.getByRole('button', { name: 'Copy Team ID' });
  await copy.focus(); await page.keyboard.press('Enter');
  await expect(copy).toHaveAttribute('aria-disabled', 'true');
  await expect(copy).toBeFocused();
  expect(await clipboardCalls(page)).toEqual([teamId]);
  const check = await foreground(page, state);
  await expect(copy).toBeFocused();
  await page.keyboard.press('Space');
  expect(await clipboardCalls(page)).toEqual([teamId]);
  await resolveClipboard(page);
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  await expect(copy).toBeFocused();
  await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  await expect(copy).toHaveAttribute('aria-disabled', 'false');
  await expect(copy).toBeFocused();
  expect(state.writes).toBe(0);
  await check.other.close();
});

test('retains a pending Team ID copy after an account switch', async ({ page }) => {
  await installClipboardProbe(page);
  const state = await install(page); await start(page);
  const copy = page.getByRole('button', { name: 'Copy Team ID' });
  await copy.click(); await expect(copy).toHaveAttribute('aria-disabled', 'true');
  const check = await foreground(page, state);
  await check.other.route('**/api/v1/me', route => route.fulfill({ json: profile, headers: { 'Daynight-User-ID': userId } }));
  await check.other.goto('/projects');
  await check.other.evaluate(id => localStorage.setItem('daynight.activeUser', JSON.stringify(id)), otherProfile.id);
  await expect(page.getByText('Account changed', { exact: true })).toBeVisible();
  await resolveClipboard(page);
  await expect(page.getByText('Copied', { exact: true })).toHaveCount(0);
  expect(state.writes).toBe(0);
  await check.other.close();
});

test('discards a pending Team ID copy after leaving and returning to settings', async ({ page }) => {
  await installClipboardProbe(page);
  const state = await install(page); await start(page);
  await page.getByRole('button', { name: 'Copy Team ID' }).click();
  await expect.poll(() => clipboardCalls(page)).toEqual([teamId]);
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy Team ID' })).toHaveCount(0);
  await resolveClipboard(page);
  await page.getByRole('link', { name: 'Team settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copy Team ID' })).toBeVisible();
  await expect(page.getByText('Copied', { exact: true })).toHaveCount(0);
  expect(state.writes).toBe(0);
});
