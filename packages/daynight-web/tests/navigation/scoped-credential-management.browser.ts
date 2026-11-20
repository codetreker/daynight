import { expect, test, type Page } from '@playwright/test';

const path = '/tests/navigation/scoped-credential-management.html';
const labels = {
  en: { edit: 'Edit permissions', task: 'Tasks', add: 'Added', remove: 'Removed', cancel: 'Cancel', tokenSave: 'Save', grantSave: 'Save permissions' },
  'zh-CN': { edit: '编辑权限', task: '任务', add: '新增', remove: '移除', cancel: '取消', tokenSave: '保存', grantSave: '保存权限' },
} as const;
const fits = async (page: Page) => {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), controls: [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] input, [role="dialog"] summary')].filter(el => el.getClientRects().length > 0).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, text: el.textContent }; }) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  for (const control of dimensions.controls) { expect(control.left, control.text ?? '').toBeGreaterThanOrEqual(-1); expect(control.right, control.text ?? '').toBeLessThanOrEqual(dimensions.width + 1); }
};

for (const locale of ['en', 'zh-CN'] as const) for (const kind of ['token', 'grant'] as const) {
  const m = labels[locale];
  test(`${kind} ${locale}: collapsed editor, changes, empty selection and focus restoration at 320px`, async ({ page }) => {
    await page.goto(`${path}?kind=${kind}&locale=${locale}`);
    const opener = page.getByRole('button', { name: new RegExp(`^${m.edit}`) });
    await expect(opener).toBeEnabled(); await opener.focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: m.edit });
    await expect(dialog).toBeVisible();
    const groups = dialog.locator('.credential-scope-group'); await expect(groups).toHaveCount(2);
    for (const group of await groups.all()) await expect(group).not.toHaveAttribute('open');
    const group = groups.filter({ has: page.getByText(m.task, { exact: true }) });
    await expect(group.locator('.credential-scope-group-count')).toHaveText('1 / 2');
    const save = dialog.getByRole('button', { name: kind === 'token' ? m.tokenSave : m.grantSave, exact: true });
    await expect(save).toBeDisabled(); await fits(page);
    await group.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(group).toHaveAttribute('open');
    const read = group.locator('label').filter({ has: page.locator('code', { hasText: 'task:read' }) }).getByRole('checkbox');
    const write = group.locator('label').filter({ has: page.locator('code', { hasText: 'task:write' }) }).getByRole('checkbox');
    await expect(read).toBeChecked(); await expect(write).not.toBeChecked();
    await write.check(); await expect(group.locator('.credential-scope-group-count')).toHaveText('2 / 2');
    await expect(dialog.getByRole('region', { name: locale === 'en' ? 'Permission changes' : '权限变更' })).toContainText('task:write');
    await expect(save).toBeEnabled();
    await read.uncheck(); await write.uncheck(); await expect(group.locator('.credential-scope-group-count')).toHaveText('0 / 2');
    await expect(dialog.getByRole('region', { name: locale === 'en' ? 'Permission changes' : '权限变更' })).toContainText('task:read');
    await expect(save).toBeDisabled(); await fits(page);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
    await opener.click(); const reopened = page.getByRole('dialog', { name: m.edit });
    for (const entry of await reopened.locator('.credential-scope-group').all()) await expect(entry).not.toHaveAttribute('open');
    const reopenedTask = reopened.locator('.credential-scope-group').filter({ has: page.getByText(m.task, { exact: true }) });
    await expect(reopenedTask.locator('.credential-scope-group-count')).toHaveText('1 / 2');
    await expect(reopened.getByRole('button', { name: kind === 'token' ? m.tokenSave : m.grantSave, exact: true })).toBeDisabled();
    await reopened.getByRole('button', { name: m.cancel, exact: true }).click(); await expect(opener).toBeFocused();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.writes') ?? '[]'))).toEqual([]);
  });
}

for (const locale of ['en', 'zh-CN'] as const) {
  test(`manual PAT ${locale}: CLI defaults, empty selection and actual submitted scopes`, async ({ page }) => {
    await page.goto(`${path}?kind=token&locale=${locale}`);
    const create = locale === 'en' ? 'Create token' : '创建令牌';
    const title = locale === 'en' ? 'Create personal access token' : '创建个人访问令牌';
    await page.getByRole('button', { name: create, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: title });
    const groups = dialog.locator('.credential-scope-group'); await expect(groups).toHaveCount(2);
    for (const group of await groups.all()) await expect(group).not.toHaveAttribute('open');
    await expect(groups.nth(0).locator('.credential-scope-group-count')).toHaveText('2 / 2');
    await expect(groups.nth(1).locator('.credential-scope-group-count')).toHaveText('1 / 2');
    await dialog.locator('#token-name').fill('Automation');
    await groups.nth(0).locator('summary').click();
    await groups.nth(0).locator('input').first().uncheck();
    await groups.nth(1).locator('summary').click();
    await groups.nth(1).locator('label').filter({ has: page.locator('code', { hasText: 'team:read' }) }).getByRole('checkbox').uncheck();
    const submit = dialog.getByRole('button', { name: create, exact: true });
    await expect(submit).toBeDisabled(); await fits(page);
    await groups.nth(1).locator('label').filter({ has: page.locator('code', { hasText: 'team:read' }) }).getByRole('checkbox').check();
    await expect(submit).toBeEnabled(); await submit.click();
    await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.writes') ?? '[]'))).toMatchObject([{ name: 'Automation', scopes: ['team:read'], catalogRevision: 'a'.repeat(64) }]);
  });
}
