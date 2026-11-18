import { expect, test, type Page } from '@playwright/test';
import type { WorkerAlias } from '../../src/api/worker-alias';
import { WORKER_USER, workerPage, workerSummary } from '../helpers/workers';
import { installTools, targetWorker } from './worker-tool-paths-fixture';

const expectTitleLayout = async (page: Page, width: number, placement: 'same-row' | 'wrapped' | 'either') => {
  const row = page.locator('.worker-title-row');
  await expect(row).toBeVisible();
  const heading = row.getByRole('heading', { level: 1 }), trigger = row.getByRole('button');
  await expect(trigger).toBeVisible();
  await expect(heading.getByRole('button')).toHaveCount(0);
  const titleBox = (await heading.boundingBox())!, triggerBox = (await trigger.boundingBox())!;
  const metadataBox = (await page.locator('.worker-description').boundingBox())!;
  const sameRow = Math.abs(titleBox.y + titleBox.height / 2 - triggerBox.y - triggerBox.height / 2) <= 1;
  if (placement === 'same-row') expect(sameRow).toBe(true);
  else if (placement === 'wrapped') expect(sameRow).toBe(false);
  if (sameRow) expect(triggerBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
  else {
    expect(triggerBox.y).toBeGreaterThanOrEqual(titleBox.y + titleBox.height);
    expect(triggerBox.x).toBeCloseTo(titleBox.x, 0);
  }
  expect(triggerBox.y + triggerBox.height).toBeLessThanOrEqual(metadataBox.y);
  expect(await trigger.evaluate((button) => Boolean(button.compareDocumentPosition(document.querySelector('.worker-description')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  if (width === 320) expect(triggerBox.height).toBeGreaterThanOrEqual(44);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
};

for (const width of [1440, 320]) for (const locale of ['zh-CN', 'en'] as const) {
  test(`${width}px ${locale} alias keyboard editing, errors, duplicate names and narrow layout`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const underlying = await installTools(page, { locale });
    let alias: WorkerAlias = { value: null, version: '1' }, fail = false, writes = 0;
    await page.route('**/api/v1/me/workers**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Alias': '1', 'Daynight-Worker-Tool-Paths': '2' } });
      if (path === `/api/v1/me/workers/${targetWorker}/alias`) {
        if (request.method() === 'PUT') {
          writes++;
          if (fail) { fail = false; return send({ error: { code: 'invalid_input', message: 'Rejected', requestId: 'alias-browser' } }, 400); }
          const input = request.postDataJSON() as { value: string | null; expectedVersion: string };
          expect(input.expectedVersion).toBe(alias.version);
          alias = { value: input.value, version: String(BigInt(alias.version) + 1n) };
        }
        return send({ workerId: targetWorker, alias });
      }
      if (path === `/api/v1/me/workers/${targetWorker}`) return send({ ...underlying.detail, worker: { ...underlying.detail.worker, alias } });
      if (path === '/api/v1/me/workers') return send(workerPage([workerSummary(1), workerSummary(2)].map(worker => ({ ...worker, machine: workerSummary(1).machine, alias }))));
      return route.fallback();
    });
    const zh = locale === 'zh-CN';
    const setName = zh ? '设置别名' : 'Set alias', editName = zh ? '修改别名' : 'Edit alias', saveName = zh ? '保存别名' : 'Save alias';
    const cancelName = zh ? '取消' : 'Cancel', clearName = zh ? '清除别名' : 'Clear alias';
    await page.goto(`/workers/${targetWorker}`);
    const opener = page.getByRole('button', { name: setName, exact: true });
    await expectTitleLayout(page, width, 'same-row');
    await opener.focus(); await page.keyboard.press('Enter');
    const input = page.getByRole('textbox', { name: zh ? 'Worker 别名' : 'Worker alias', exact: true });
    await expect(input).toBeFocused();
    expect(await input.evaluate(element => Boolean(document.querySelector('.worker-id')!.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    await input.fill('draft'); await page.keyboard.press('Escape');
    await expect(opener).toBeFocused(); expect(writes).toBe(0);
    await opener.click(); await input.fill('办公室 Windows');
    await page.getByRole('button', { name: saveName, exact: true }).click();
    await expect(page.getByRole('heading', { name: '办公室 Windows', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: editName, exact: true })).toBeFocused();
    await expectTitleLayout(page, width, width === 1440 ? 'same-row' : 'either');
    await page.reload(); await expect(page.getByRole('heading', { name: '办公室 Windows', exact: true })).toBeVisible();
    await page.getByRole('button', { name: editName, exact: true }).click();
    const long = '很长的办公室😀'.repeat(10);
    await input.fill(long); fail = true;
    await page.getByRole('button', { name: saveName, exact: true }).click();
    await expect(page.locator('.worker-alias-form [role="alert"]')).toBeVisible(); await expect(input).toHaveValue(long);
    await page.getByRole('button', { name: saveName, exact: true }).click();
    await expect(page.getByRole('heading', { name: long, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: editName, exact: true })).toBeFocused();
    await expectTitleLayout(page, width, 'wrapped');
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await info.attach('alias-detail', { body: await page.screenshot(), contentType: 'image/png' });
    await page.getByRole('link', { name: zh ? '返回我的 Worker' : 'Back to my Workers' }).click();
    await expect(page.getByRole('heading', { name: long, exact: true })).toHaveCount(2);
    await expect(page.locator('.worker-card-id')).toHaveCount(2);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.locator(`a.worker-card[href="/workers/${targetWorker}"]`).click();
    await page.getByRole('button', { name: editName, exact: true }).click();
    await input.fill('cancelled'); await page.getByRole('button', { name: cancelName, exact: true }).click();
    expect(alias.value).toBe(long);
    await page.getByRole('button', { name: editName, exact: true }).click();
    await page.getByRole('button', { name: clearName, exact: true }).click();
    await expect(page.getByRole('heading', { name: workerSummary(1).machine.name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: setName, exact: true })).toBeFocused();
    await expectTitleLayout(page, width, 'same-row');
    expect(alias.value).toBeNull(); expect(writes).toBe(4);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.route(`**/api/v1/me/workers/${targetWorker}`, route => route.fulfill({ json: underlying.detail, headers: { 'Daynight-User-ID': WORKER_USER, 'Daynight-Worker-Tool-Paths': '2' } }));
    await page.reload();
    await expect(page.getByRole('heading', { name: workerSummary(1).machine.name, exact: true })).toBeVisible();
    await expect(page.locator('.worker-title-row button')).toHaveCount(0);
    const headingBox = (await page.locator('.worker-title-row').boundingBox())!, metadataBox = (await page.locator('.worker-description').boundingBox())!;
    expect(headingBox.y + headingBox.height).toBeLessThanOrEqual(metadataBox.y);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
