import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    navigationHistoryEvents: { readonly physical: string; readonly accepted: string | null; readonly pending: boolean; readonly state: unknown }[];
  }
}

const project = '/projects/a0000000-0000-0000-0000-000000000001';
const first = `${project}/tasks/b0000000-0000-0000-0000-000000000001`;
const second = `${project}/tasks/b0000000-0000-0000-0000-000000000002`;
const third = `${project}/tasks/b0000000-0000-0000-0000-000000000003`;
const accepted = (page: Page) => page.getByTestId('accepted');
const dialog = (page: Page) => page.getByRole('alertdialog');
const cancel = (page: Page) => dialog(page).locator('footer button').first().click();
const confirm = (page: Page) => dialog(page).locator('footer button').last().click();
const counts = (page: Page) => page.evaluate(() => ({ ...window.navigationHost.counters }));
const physical = (page: Page) => page.evaluate(() => location.pathname + location.search + location.hash);
const edit = (page: Page) => page.getByRole('textbox', { name: 'Draft' }).fill('preserve this unsaved text · 保留草稿');
const go = (page: Page, destination: string) => page.evaluate((url) => window.navigationHost.navigate(url), destination);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { history.replaceState({ otherOwner: 'preserved' }, '', location.href); });
});

for (const operation of ['Program navigation', 'Replace navigation', 'Relation', 'Close']) {
  test(`${operation} decides before history writes or editor unmount`, async ({ page }) => {
    await page.goto(first);
    await edit(page);
    const length = await page.evaluate(() => history.length);
    const before = await counts(page);
    await page.getByRole('button', { name: operation, exact: true }).click();
    await expect(dialog(page)).toBeVisible();
    await expect(accepted(page)).toHaveText(first);
    expect(await physical(page)).toBe(first);
    expect(await counts(page)).toEqual(before);
    expect(await page.evaluate(() => history.length)).toBe(length);
    await cancel(page);
    await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('preserve this unsaved text · 保留草稿');
    await expect(page.getByRole('button', { name: operation, exact: true })).toBeFocused();
    await page.getByRole('button', { name: operation, exact: true }).click();
    await confirm(page);
    await expect(dialog(page)).toHaveCount(0);
    await expect(accepted(page)).toHaveText(operation === 'Close' ? project : second);
    expect((await counts(page)).discards).toBe(before.discards + 1);
    expect((await counts(page)).unmounts).toBe(before.unmounts + 1);
    expect(await page.evaluate(() => history.length)).toBe(length + (operation === 'Replace navigation' ? 0 : 1));
  });
}

test('modal close and relation use admission without a URL change', async ({ page }) => {
  await page.goto(project);
  await page.getByRole('button', { name: 'Open modal Task' }).click();
  await edit(page);
  const length = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Relation', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await cancel(page);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  await page.getByRole('button', { name: 'Relation', exact: true }).click();
  await confirm(page);
  await expect(page.getByTestId('task-id')).toHaveText(second.split('/').at(-1)!);
  await edit(page);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await confirm(page);
  await expect(page.getByTestId('surface')).toHaveCount(0);
  expect(await physical(page)).toBe(project);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect((await counts(page)).actions).toBe(2);
  expect((await counts(page)).discards).toBe(2);
});

test('opening a standalone view from a modal still guards its editor lifetime', async ({ page }) => {
  await page.goto(project);
  await page.getByRole('button', { name: 'Open modal Task' }).click();
  await edit(page);
  await page.getByRole('button', { name: 'Same Task tab' }).click();
  await expect(dialog(page)).toBeVisible();
  expect(await physical(page)).toBe(project);
  await cancel(page);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
});

test('same Task tabs, attachment paths and history retain the editor', async ({ page }) => {
  await page.goto(first);
  await edit(page);
  const before = await counts(page);
  await page.getByRole('button', { name: 'Same Task tab' }).click();
  await expect(accepted(page)).toHaveText(`${first}?tab=discussion`);
  await page.getByRole('button', { name: 'Same Task attachment' }).click();
  await expect(accepted(page)).toHaveText(`${first}/attachments/readme.md`);
  await page.evaluate(() => history.back());
  await expect(accepted(page)).toHaveText(`${first}?tab=discussion`);
  await page.evaluate(() => history.back());
  await expect(accepted(page)).toHaveText(first);
  await page.evaluate(() => history.forward());
  await expect(accepted(page)).toHaveText(`${first}?tab=discussion`);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  expect(await counts(page)).toEqual(before);
});

test('single Back cancel restores its original entry; Forward confirm adopts once', async ({ page }) => {
  await page.goto(first);
  await go(page, second);
  await edit(page);
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await expect(accepted(page)).toHaveText(second);
  expect(await physical(page)).toBe(first);
  await cancel(page);
  await expect.poll(() => physical(page)).toBe(second);
  await expect(accepted(page)).toHaveText(second);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  expect(await page.evaluate(() => history.length)).toBe(length);
  // An admitted Back and Forward exercise the real numbered entries in both directions.
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await confirm(page);
  await expect(accepted(page)).toHaveText(first);
  await edit(page);
  await page.evaluate(() => history.forward());
  await expect(dialog(page)).toBeVisible();
  await expect(accepted(page)).toHaveText(first);
  expect(await physical(page)).toBe(second);
  const before = await counts(page);
  await confirm(page);
  await expect(accepted(page)).toHaveText(second);
  expect((await counts(page)).discards).toBe(before.discards + 1);
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test('consecutive Back and Forward update the latest target in one confirmation', async ({ page }) => {
  await page.goto(first);
  await go(page, second);
  await go(page, third);
  await edit(page);
  const length = await page.evaluate(() => history.length);
  const before = await counts(page);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect.poll(() => physical(page)).toBe(first);
  await page.evaluate(() => history.forward());
  await expect.poll(() => physical(page)).toBe(second);
  await expect(dialog(page)).toHaveCount(1);
  await expect(accepted(page)).toHaveText(third);
  await confirm(page);
  await expect(accepted(page)).toHaveText(second);
  expect((await counts(page)).discards).toBe(before.discards + 1);
  expect((await counts(page)).unmounts).toBe(before.unmounts + 1);
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test('consecutive history cancellation returns to the committed entry without duplication', async ({ page }) => {
  await page.goto(first);
  await go(page, second);
  await go(page, third);
  await edit(page);
  const length = await page.evaluate(() => history.length);
  const before = await counts(page);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => history.back());
  await expect.poll(() => physical(page)).toBe(first);
  await cancel(page);
  await expect.poll(() => physical(page)).toBe(third);
  await expect(accepted(page)).toHaveText(third);
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  expect(await counts(page)).toEqual(before);
  expect(await page.evaluate(() => history.length)).toBe(length);
});

for (const movement of ['back', 'forward', 'go(-2)', 'listener']) {
  test(`history ${movement} during cancellation cannot adopt a route or erase a draft`, async ({ page }, testInfo) => {
    await page.goto(first);
    await go(page, second);
    await go(page, third);
    await go(page, `${first}?tab=discussion`);
    await edit(page);
    const length = await page.evaluate(() => history.length);
    const before = await counts(page);
    await page.evaluate(() => {
      window.navigationHistoryEvents = [];
      addEventListener('popstate', () => window.navigationHistoryEvents.push({
        physical: location.pathname + location.search + location.hash,
        accepted: document.querySelector('[data-testid=accepted]')!.textContent,
        pending: window.navigationHost.pending(), state: history.state,
      }));
    });
    await page.evaluate(() => history.back());
    await expect(dialog(page)).toBeVisible();
    await page.evaluate((move) => {
      if (move === 'listener') {
        // This observer races the application's restoration listener with a
        // real traversal, without duplicating any recovery implementation.
        addEventListener('popstate', () => history.back(), { once: true });
        window.navigationHost.cancel();
      } else {
        window.navigationHost.cancel();
        if (move === 'back') history.back();
        else if (move === 'forward') history.forward();
        else history.go(-2);
      }
    }, movement);
    try {
      if (movement === 'go(-2)' || movement === 'listener') {
        // Chromium delivers these traversals after the origin has been
        // restored. They are new leave requests, rather than recovery events.
        await expect.poll(() => physical(page)).toBe(movement === 'go(-2)' ? second : third);
        await expect(dialog(page)).toBeVisible();
        expect(await page.evaluate(() => window.navigationHistoryEvents)).toContainEqual(expect.objectContaining({
          physical: `${first}?tab=discussion`, pending: false,
        }));
        await cancel(page);
      }
      await expect(accepted(page)).toHaveText(`${first}?tab=discussion`);
      await expect.poll(() => physical(page)).toBe(`${first}?tab=discussion`);
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
      expect(await counts(page)).toEqual(before);
      expect(await page.evaluate(() => history.length)).toBe(length);
    } finally {
      await testInfo.attach('history-events', { body: JSON.stringify(await page.evaluate(() => window.navigationHistoryEvents), null, 2), contentType: 'application/json' });
    }
  });
}

test('identity retirement during history recovery cannot restore private content', async ({ page }) => {
  await page.goto(first);
  await go(page, second);
  await go(page, third);
  await edit(page);
  const length = await page.evaluate(() => history.length);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => { window.navigationHost.cancel(); window.navigationHost.retire(); });
  await expect(page.getByTestId('retired')).toHaveText('true');
  await expect(page.getByTestId('surface')).toHaveCount(0);
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(async () => await accepted(page).textContent() === await physical(page)).toBe(true);
  expect((await counts(page)).discards).toBe(1);
  expect(await page.evaluate(() => history.length)).toBe(length);
});

test('returning to the original Task while deciding does not discard its draft', async ({ page }) => {
  await page.goto(first);
  await go(page, second);
  await edit(page);
  const before = await counts(page);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => history.forward());
  await expect.poll(() => physical(page)).toBe(second);
  await expect(dialog(page)).toHaveCount(0);
  await expect(accepted(page)).toHaveText(second);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  expect(await counts(page)).toEqual(before);
});

test('whole-document departure invokes beforeunload and cancellation preserves the editor', async ({ page }) => {
  await page.goto(first);
  await edit(page);
  const pendingDialog = page.waitForEvent('dialog');
  const click = page.getByRole('link', { name: 'Document departure' }).click({ noWaitAfter: true });
  const nativeDialog = await pendingDialog;
  expect(nativeDialog.type()).toBe('beforeunload');
  await nativeDialog.dismiss();
  await click;
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  expect(await physical(page)).toBe(first);
  const nextDialog = page.waitForEvent('dialog');
  const leave = page.getByRole('link', { name: 'Document departure' }).click({ noWaitAfter: true });
  await (await nextDialog).accept();
  await leave;
  await expect(accepted(page)).toHaveText('/outside');
});

test('identity retirement clears a pending choice and private text immediately', async ({ page }) => {
  await page.goto(first);
  await edit(page);
  await page.getByRole('button', { name: 'Program navigation', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await page.evaluate(() => window.navigationHost.retire());
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId('surface')).toHaveCount(0);
  expect((await counts(page)).discards).toBe(1);
  await page.getByRole('button', { name: 'New identity' }).click();
  await expect(page.getByRole('textbox', { name: 'Draft' })).toHaveValue('');
  await go(page, second);
  await expect(accepted(page)).toHaveText(second);
  await expect(dialog(page)).toHaveCount(0);
});

test('foreign unnumbered entries stay unnumbered and follow the accepted native limitation', async ({ page }) => {
  await page.goto(first);
  await edit(page);
  await page.evaluate((url) => {
    history.pushState({ foreign: true }, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, second);
  await expect(accepted(page)).toHaveText(second);
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => history.state)).toEqual({ foreign: true });
  // Native fragment entries are not repaired or assigned an application index.
  await page.evaluate(() => { location.hash = 'native-fragment'; });
  await expect.poll(() => physical(page)).toBe(`${second}#native-fragment`);
  expect(await page.evaluate(() => history.state?.__daynightNavigation)).toBeUndefined();
});

test('startup and replacement preserve other history state without an extra entry', async ({ page }) => {
  await page.goto(first);
  const length = await page.evaluate(() => history.length);
  expect(await page.evaluate(() => history.state.otherOwner)).toBe('preserved');
  await page.evaluate((url) => window.navigationHost.replace(url), second);
  await expect(accepted(page)).toHaveText(second);
  expect(await page.evaluate(() => history.length)).toBe(length);
  expect(await page.evaluate(() => history.state.otherOwner)).toBe('preserved');
});

for (const width of [1280, 320]) {
  test(`native message details yield to history confirmation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(first);
    await go(page, second);
    await edit(page);
    const before = await counts(page);
    const length = await page.evaluate(() => history.length);
    await page.getByRole('button', { name: 'Message details', exact: true }).click();
    const metadata = page.locator('dialog.thread-metadata-dialog');
    await expect(metadata).toBeVisible();
    expect(await metadata.evaluate((element) => element.matches(':modal'))).toBe(true);
    await page.evaluate(() => history.back());
    await expect(dialog(page)).toBeVisible();
    await expect(metadata).toHaveCount(0);
    await expect(dialog(page).locator('footer button').first()).toBeFocused();
    await page.keyboard.press('Tab');
    expect(await dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => physical(page)).toBe(second);
    await expect(accepted(page)).toHaveText(second);
    await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
    await expect(page.getByRole('textbox', { name: 'Draft' })).toBeFocused();
    await expect(metadata).toHaveCount(0);
    expect(await counts(page)).toEqual(before);
    expect(await page.evaluate(() => history.length)).toBe(length);
  });
}

test('native attachment deletion yields to history confirmation at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(first);
  await go(page, second);
  await edit(page);
  const before = await counts(page);
  const length = await page.evaluate(() => history.length);
  await page.getByRole('button', { name: 'Delete attachment', exact: true }).click();
  const deletion = page.locator('dialog.attachment-delete-dialog');
  await expect(deletion).toBeVisible();
  expect(await deletion.evaluate((element) => element.matches(':modal'))).toBe(true);
  await page.evaluate(() => history.back());
  await expect(dialog(page)).toBeVisible();
  await expect(deletion).toHaveCount(0);
  await expect(dialog(page).locator('footer button').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => physical(page)).toBe(second);
  await expect(accepted(page)).toHaveText(second);
  await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Draft' })).toBeFocused();
  await expect(deletion).toHaveCount(0);
  expect(await counts(page)).toEqual(before);
  expect(await page.evaluate(() => history.length)).toBe(length);
});

for (const locale of ['en', 'zh-CN']) {
  for (const width of [1280, 320]) {
    test(`${locale} ${width}px confirmation traps focus and Escape preserves lower layers`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((language) => localStorage.setItem('daynight.web.locale', language), locale);
      await page.goto(first);
      await edit(page);
      await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(dialog(page)).toBeVisible();
      await expect(dialog(page).locator('footer button').first()).toBeFocused();
      await expect(dialog(page)).toContainText(locale === 'en' ? /draft|unsaved/i : /草稿|未保存/);
      for (let index = 0; index < 8; index++) {
        await page.keyboard.press('Tab');
        expect(await dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Shift+Tab');
      expect(await dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      const bounds = await dialog(page).boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      await testInfo.attach('confirmation', { body: await page.screenshot(), contentType: 'image/png' });
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toHaveCount(0);
      await expect(page.getByTestId('fullscreen')).toHaveText('true');
      await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await expect(page.getByRole('textbox', { name: 'Draft' })).not.toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('fullscreen')).toHaveText('false');
      await page.keyboard.press('Escape');
      await expect(dialog(page)).toBeVisible();
      await cancel(page);
    });
  }
}
