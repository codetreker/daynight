import { expect, test } from '@playwright/test';

const userId = '00000000-0000-4000-8000-000000000201', personalId = '00000000-0000-4000-8000-000000000701', teamId = '00000000-0000-4000-8000-000000000021';
const team = { id: teamId, kind: 'ordinary', name: 'Collaboration Team' }, time = '2026-10-20T09:00:00Z';
const membership = { teamId, userId, role: 'member', version: 1, createdAt: time, updatedAt: time };
const token = 'dnteam_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

test('Team invitation success remains readable and navigable at 320px in both languages', async ({ page }) => {
  let accepts = 0;
  await page.addInitScript(() => localStorage.setItem('daynight.web.locale', 'zh-CN'));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (body: unknown, status = 200) => route.fulfill({ json: body, status, headers: { 'Daynight-User-ID': userId } });
    if (path === '/api/v1/me') return send({ id: userId, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Alice', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/team-invitations/inspect') return send({ team, membership: null });
    if (path === '/api/v1/team-invitations/accept') { accepts++; expect(request.postDataJSON()).toEqual({ token, expectedUserId: userId }); return send({ team, membership, joined: true, consumed: true }); }
    if (path === '/api/v1/teams') return send({ items: [{ ...team, version: 1, createdAt: time, updatedAt: time, membership }], nextCursor: null });
    if (path === `/api/v1/teams/${teamId}`) return send({ ...team, version: 1, createdAt: time, updatedAt: time, membership });
    if (path === `/api/v1/teams/${personalId}`) return send({ id: personalId, kind: 'personal', name: null, version: 1, createdAt: time, updatedAt: time, membership: { ...membership, teamId: personalId, role: 'admin' } });
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'not found', requestId: 'fixture' } }, 404);
  });
  await page.goto(`/team-invitations#${token}`);
  await expect(page.getByRole('heading', { name: '你受邀加入一个 Team' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  expect(await page.evaluate(secret => !JSON.stringify(history.state).includes(secret), token)).toBe(true);
  expect(accepts).toBe(0); await page.getByRole('button', { name: '接受邀请并加入', exact: true }).click();
  await expect(page.getByText('你已加入此 Team', { exact: true })).toBeVisible();
  await expect(page.getByText(team.name, { exact: true })).toBeVisible(); await expect(page.getByText(`Team ID: ${teamId}`, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
  await page.getByRole('combobox', { name: '语言 / Language' }).selectOption('en');
  await expect(page.getByText('You joined this Team', { exact: true })).toBeVisible();
  await expect(page.getByText(`Team ID: ${teamId}`, { exact: true })).toBeVisible();
  const open = page.getByRole('link', { name: 'Open Team', exact: true }); await expect(open).toHaveAttribute('href', `/teams/${teamId}`); await expect(open).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= innerWidth)).toBe(true);
  await open.click(); await expect(page).toHaveURL(new RegExp(`/teams/${teamId}$`));
  await expect(page.getByRole('heading', { name: team.name, exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(id => localStorage.getItem(`daynight.selectedTeam:${id}`), userId)).toBe(teamId);
  expect(accepts).toBe(1);
});
