import { expect, test, type Page } from '@playwright/test';

const path = '/tests/navigation/scoped-authorization.html';
const labels = {
  en: { team: 'Teams', group: 'Select this group · Teams', match: 'This code matches the one in my terminal', deviceApprove: 'Authorize CLI', deviceDeny: 'Deny request', oauthApprove: 'Allow access', oauthDeny: 'Deny', deviceUnknown: 'Your decision could not be confirmed', oauthUnknown: 'Authorization outcome unconfirmed', deviceCheck: 'Check actual result', oauthCheck: 'Check authorization status', deviceDenied: 'Request denied', oauthDenied: 'Access denied' },
  'zh-CN': { team: 'Team', group: '全选本组 · Team', match: '与我的终端显示的授权码一致', deviceApprove: '授权 CLI', deviceDeny: '拒绝请求', oauthApprove: '允许访问', oauthDeny: '拒绝', deviceUnknown: '尚未确认授权结果', oauthUnknown: '授权结果尚未确认', deviceCheck: '核对实际结果', oauthCheck: '检查授权状态', deviceDenied: '请求已拒绝', oauthDenied: '已拒绝访问' },
} as const;
const fits = async (page: Page) => {
  const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), controls: [...document.querySelectorAll('main button, main input, main summary, main select')].filter(el => el.getClientRects().length > 0).map(el => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, text: el.textContent }; }) }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  for (const control of dimensions.controls) { expect(control.left, control.text ?? '').toBeGreaterThanOrEqual(-1); expect(control.right, control.text ?? '').toBeLessThanOrEqual(dimensions.width + 1); }
};
const decisions = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('fixture.decisions') ?? '[]') as unknown[]);

for (const locale of ['en', 'zh-CN'] as const) for (const kind of ['device', 'oauth'] as const) {
  const m = labels[locale], approve = kind === 'device' ? m.deviceApprove : m.oauthApprove, deny = kind === 'device' ? m.deviceDeny : m.oauthDeny;
  test(`${kind} ${locale}: narrow layout, group selection, empty approval and denial survive request reload`, async ({ page }) => {
    await page.goto(`${path}?kind=${kind}&locale=${locale}`);
    const group = page.locator('.credential-scope-group').filter({ has: page.getByText(m.team, { exact: true }) });
    await expect(group).toBeVisible(); await expect(group).not.toHaveAttribute('open'); await expect(group.locator('.credential-scope-group-count')).toHaveText('1 / 2');
    await fits(page);
    await group.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(group).toHaveAttribute('open');
    await expect(group.getByRole('checkbox', { name: m.group })).toHaveJSProperty('indeterminate', true);
    await group.getByRole('checkbox', { name: m.group }).check(); await expect(group.locator('.credential-scope-group-count')).toHaveText('2 / 2');
    await group.getByRole('checkbox', { name: m.group }).uncheck();
    if (kind === 'device') {
      const worker = page.locator('.credential-scope-group').nth(1); await worker.locator('summary').click();
      await worker.locator('input').first().uncheck(); await page.getByRole('checkbox', { name: m.match }).check();
    }
    await expect(page.getByRole('button', { name: approve })).toBeDisabled(); await fits(page);
    await page.getByRole('button', { name: deny, exact: true }).click();
    await expect(page.getByRole('heading', { name: kind === 'device' ? m.deviceDenied : m.oauthDenied })).toBeVisible();
    expect(await decisions(page)).toHaveLength(1);
    expect((await decisions(page))[0]).toMatchObject({ decision: 'deny' });
    await page.reload();
    await expect(page.getByRole('heading', { name: kind === 'device' ? m.deviceDenied : m.oauthDenied })).toBeVisible();
    expect(await decisions(page)).toHaveLength(1); await fits(page);
  });
  test(`${kind} ${locale}: unknown result survives reload and pending check never repeats decision`, async ({ page }) => {
    await page.goto(`${path}?kind=${kind}&locale=${locale}&unknown=1`);
    await expect(page.locator('.credential-scope-group').first()).toBeVisible();
    const group = page.locator('.credential-scope-group').first(); await group.locator('summary').click(); await group.getByRole('checkbox', { name: m.group }).check();
    if (kind === 'device') await page.getByRole('checkbox', { name: m.match }).check();
    await page.getByRole('button', { name: approve }).click();
    await expect(page.getByText(kind === 'device' ? m.deviceUnknown : m.oauthUnknown, { exact: true })).toBeVisible();
    expect((await decisions(page))[0]).toMatchObject({ decision: 'approve', selection: { scopes: expect.arrayContaining(['team:read', 'team:write']) } });
    await page.reload(); await expect(page.getByText(kind === 'device' ? m.deviceUnknown : m.oauthUnknown, { exact: true })).toBeVisible();
    await page.getByRole('button', { name: kind === 'device' ? m.deviceCheck : m.oauthCheck }).click();
    await expect(page.getByText(kind === 'device' ? m.deviceUnknown : m.oauthUnknown, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: approve })).toHaveCount(0); await expect(page.getByRole('button', { name: deny, exact: true })).toHaveCount(0);
    expect(await decisions(page)).toHaveLength(1);
    await page.evaluate(() => sessionStorage.setItem('fixture.status', 'denied'));
    await page.getByRole('button', { name: kind === 'device' ? m.deviceCheck : m.oauthCheck }).click();
    await expect(page.getByRole('heading', { name: kind === 'device' ? m.deviceDenied : m.oauthDenied })).toBeVisible();
    expect(await decisions(page)).toHaveLength(1); await fits(page);
  });
}
