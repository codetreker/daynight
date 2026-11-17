import { expect, test, type Page } from '@playwright/test';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';

const personalId = botId(100), personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Deletion fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const target = botDefinition(1), other = botDefinition(2);

async function install(page: Page, passiveCompleted = false) {
  let request: { ifVersion: string; deletionId: string } | null = passiveCompleted ? { ifVersion: '1', deletionId: botId(90) } : null;
  let completed = passiveCompleted;
  const writes: string[] = [];
  await page.route('**/api/v1/**', async route => {
    const http = route.request(), path = new URL(http.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(http.headers(), status) } });
    const result = () => ({ id: target.id, workerId: target.workerId, version: completed ? '3' : '2', deletion: {
      deletionId: request!.deletionId, requestedVersion: request!.ifVersion,
      workerCleanup: { state: 'completed', code: null }, serverCleanup: { state: completed ? 'completed' : 'pending', code: null },
    } });
    if (http.method() !== 'GET') {
      writes.push(`${http.method()} ${path}`);
      if (http.method() === 'DELETE' && path === `/api/v1/me/bots/${target.id}`) {
        request = http.postDataJSON();
        expect(request?.ifVersion).toBe('1');
        return send(result());
      }
      throw new Error(`Unexpected write: ${http.method()} ${path}`);
    }
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    // A stale list must not revive the deleted assistant.
    if (path === '/api/v1/me/bots') return send({ items: [target, other], nextCursor: null });
    if (path === `/api/v1/me/bots/${target.id}`) return send(request ? result() : target);
    if (path === `/api/v1/me/bots/${other.id}`) return send(other);
    if (path === '/api/v1/assistant-tasks') return send({ items: [], nextCursor: null, observedAt: BOT_TIME });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'deletion-fixture' } }, 404);
  });
  return { complete: () => { completed = true; }, writes };
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) for (const selected of [false, true]) {
  test(`withdraws ${selected ? 'selected' : 'list'} deletion feedback in ${locale} at ${width}px`, async ({ page }) => {
    const fixture = await install(page);
    const names = locale === 'en'
      ? { more: 'More actions for Assistant 1', remove: 'Delete assistant', status: 'Assistant deletion', pending: 'Waiting for cleanup', completed: 'Deletion completed', check: 'Check deletion', deleted: 'This assistant has been deleted.', back: 'Back to assistants', cancel: 'Cancel' }
      : { more: 'Assistant 1的更多操作', remove: '删除助手', status: '助手删除状态', pending: '等待清理', completed: '删除完成', check: '核对删除结果', deleted: '这个助手已删除。', back: '返回助手列表', cancel: '取消' };
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/bots');
    await page.locator('.locale-control select').selectOption(locale);
    const more = page.getByRole('button', { name: names.more });
    await expect(more).toBeVisible();
    await more.focus(); await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: names.remove }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: names.cancel }).click();
    await expect(more).toBeFocused();
    await more.press('Enter');
    await page.getByRole('menuitem', { name: names.remove }).press('Enter');
    await page.getByRole('dialog').getByRole('button', { name: names.remove }).press('Enter');
    await expect(page.getByRole('region', { name: names.status })).toContainText(names.pending);
    await expect(page.getByRole('link', { name: /Assistant 1/ })).toHaveCount(0);
    if (selected) {
      // Re-enter the old address while cleanup is pending; storage retains the original request.
      await page.goto(`/bots/${target.id}`);
      await expect(page.getByRole('region', { name: names.status })).toContainText(names.pending);
    }
    fixture.complete();
    await page.getByRole('region', { name: names.status }).getByRole('button', { name: names.check }).click();
    await expect(page.getByRole('region', { name: names.status })).toHaveCount(0);
    await expect(page.getByText(names.completed, { exact: true })).toHaveCount(0);
    if (selected) {
      await expect(page.getByRole('heading', { name: target.name })).toBeVisible();
      await expect(page.getByText(names.deleted, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole('heading', { name: target.name })).toBeVisible();
      await expect(page.getByText(names.deleted, { exact: true })).toBeVisible();
      await expect(page.getByRole('region', { name: names.status })).toHaveCount(0);
      const back = page.getByRole('link', { name: names.back });
      await back.focus(); await expect(back).toBeFocused(); await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/\/bots$/);
    }
    await page.reload();
    await expect(page.getByRole('link', { name: /Assistant 2/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Assistant 1/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: names.status })).toHaveCount(0);
    await expect(page.getByText(names.completed, { exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(fixture.writes).toEqual([`DELETE /api/v1/me/bots/${target.id}`]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) for (const width of [1280, 320]) {
  test(`passively observes completed deletion without a name in ${locale} at ${width}px`, async ({ page }) => {
    const fixture = await install(page, true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/bots/${target.id}`);
    await page.locator('.locale-control select').selectOption(locale);
    const names = locale === 'en'
      ? { title: 'Assistants', deleted: 'This assistant has been deleted.', status: 'Assistant deletion', completed: 'Deletion completed' }
      : { title: '助手', deleted: '这个助手已删除。', status: '助手删除状态', completed: '删除完成' };
    const conversation = page.locator('.bot-conversation');
    await expect(conversation.getByRole('heading', { name: names.title, exact: true })).toBeVisible();
    await expect(conversation.getByText(names.deleted, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: names.status })).toHaveCount(0);
    await expect(page.getByText(names.completed, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(conversation.getByRole('heading', { name: names.title, exact: true })).toBeVisible();
    await expect(conversation.getByText(names.deleted, { exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: names.status })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(fixture.writes).toEqual([]);
  });
}
