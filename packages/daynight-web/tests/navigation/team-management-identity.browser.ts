import { expect, test, type Page, type Route } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000001';
const personalId = '00000000-0000-4000-8000-000000000011';
const teamId = '00000000-0000-4000-8000-000000000021';
const time = '2026-10-20T09:00:00Z';
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: userId, personalTeam: personal, name: 'Alice', email: null, emailVerified: null, avatarUrl: null };
const error = (code: string) => ({ error: { code, message: code, requestId: '00000000-0000-4000-8000-000000000099' } });
type Gate = { started: () => void; wait: Promise<void> };
type State = { exists: boolean; lost: boolean; holdMe: Gate | null; holdDelete: Gate | null; writes: number; details: number };
const install = async (page: Page): Promise<State> => {
  const state: State = { exists: true, lost: false, holdMe: null, holdDelete: null, writes: 0, details: 0 };
  const team = (id: string) => ({ id, kind: id === personalId ? 'personal' : 'ordinary', name: id === personalId ? null : 'Alpha', version: 1, createdAt: time, updatedAt: time, membership: { teamId: id, userId, role: 'admin', version: 1, createdAt: time, updatedAt: time } });
  await page.route('**/api/v1/**', async (route: Route) => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const send = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') { const gate = state.holdMe; state.holdMe = null; if (gate) { gate.started(); await gate.wait; } return send(profile); }
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
    if (path === `/api/v1/teams/${teamId}`) { state.details++; return state.exists ? send(team(teamId)) : send(error('not_found'), 404); }
    return send(error('not_found'), 404);
  });
  return state;
};
const start = async (page: Page) => { await page.goto(`/teams/${teamId}/settings`); await expect(page.getByRole('button', { name: 'Edit', exact: true })).toBeVisible(); };
const openDelete = async (page: Page) => { await page.getByRole('button', { name: 'Delete Team' }).click(); const dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Enter the Team name to confirm')).toBeVisible(); return dialog; };
const foreground = async (page: Page, state: State) => {
  const primary = await page.context().newCDPSession(page); await primary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await primary.detach();
  const other = await page.context().newPage(); await other.goto('/projects');
  const secondary = await page.context().newCDPSession(other); await secondary.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await secondary.detach();
  await other.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); state.holdMe = { started: started.resolve, wait: finish.promise };
  await page.bringToFront(); await started.promise;
  return { finish: finish.resolve, other };
};

test('retains a settings draft and typed confirmation across same-user verification', async ({ page }) => {
  const state = await install(page); await start(page);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Team name').fill('Unsubmitted draft');
  const first = await foreground(page, state);
  first.finish(); await expect(page.getByRole('dialog').getByLabel('Team name')).toHaveValue('Unsubmitted draft'); await first.other.close();
  await page.keyboard.press('Escape');
  const dialog = await openDelete(page);
  const name = dialog.getByLabel('Enter the Team name to confirm'); await name.fill('Al');
  const second = await foreground(page, state);
  const backdrop = page.locator('.auth-modal-backdrop');
  await expect(backdrop).toHaveAttribute('hidden', '');
  expect(await backdrop.evaluate((el) => getComputedStyle(el).display)).toBe('none');
  await page.keyboard.press('Tab'); expect(await backdrop.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Escape');
  second.finish(); await expect(name).toHaveValue('Al'); await expect(name).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.writes).toBe(0); await second.other.close();
});

test('preserves unknown through same-user verification without replay', async ({ page }) => {
  const state = await install(page); await start(page); state.lost = true;
  const dialog = await openDelete(page); await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  const check = await foreground(page, state); check.finish();
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  expect(state.writes).toBe(1); await expect(dialog.getByRole('button', { name: 'Delete Team' })).toHaveCount(0);
  await check.other.close();
});

test('preserves an unknown rename across same-user verification and closing the dialog', async ({ page }) => {
  const state = await install(page); await start(page); state.lost = true;
  const edit = page.getByRole('button', { name: 'Edit', exact: true }); await edit.click();
  const dialog = page.getByRole('dialog'); await dialog.getByLabel('Team name').fill('New name');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByRole('alert')).toContainText('result is unknown');
  const check = await foreground(page, state); check.finish();
  await expect(dialog.getByRole('alert').first()).toContainText('result is unknown');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(edit).toBeDisabled(); expect(state.writes).toBe(1); await check.other.close();
});

test('does not navigate on a 404 while the committed delete receipt is delayed', async ({ page }) => {
  const state = await install(page); await start(page);
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); state.holdDelete = { started: started.resolve, wait: finish.promise };
  const dialog = await openDelete(page); await dialog.getByLabel('Enter the Team name to confirm').fill('Alpha'); await dialog.getByRole('button', { name: 'Delete Team' }).click(); await started.promise;
  const previousReads = state.details;
  const check = await foreground(page, state); check.finish();
  await expect.poll(() => state.details).toBeGreaterThan(previousReads);
  await expect.poll(() => new URL(page.url()).pathname).toBe(`/teams/${teamId}/settings`);
  expect(state.writes).toBe(1);
  finish.resolve();
  await expect(page.getByRole('main').getByRole('heading', { name: 'Personal', exact: true })).toBeVisible();
  expect(state.writes).toBe(1); await check.other.close();
});


test('retains the create dialog input while identity verification suspends it', async ({ page }) => {
  const state = await install(page); await page.goto('/projects');
  await page.locator('details.team-selector summary').click(); await page.getByRole('button', { name: 'Create Team', exact: true }).click();
  const backdrop = page.locator('.auth-modal-backdrop'), dialog = page.getByRole('dialog'), name = dialog.getByLabel('Team name');
  await name.fill('Unsubmitted Team');
  const check = await foreground(page, state);
  await expect(backdrop).toHaveAttribute('hidden', ''); expect(await backdrop.evaluate((el) => getComputedStyle(el).display)).toBe('none');
  await page.keyboard.press('Tab'); expect(await backdrop.evaluate((el) => el.contains(document.activeElement))).toBe(false);
  await page.keyboard.press('Escape'); check.finish();
  await expect(name).toHaveValue('Unsubmitted Team'); await expect(name).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(state.writes).toBe(0); await check.other.close();
});
