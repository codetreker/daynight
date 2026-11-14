import { expect, test, type Page } from '@playwright/test';
import { WORKER_TIME, workerDetail } from '../helpers/workers';
import { deferredRead, installTools, observedConfiguration, openToolConfiguration, pathChoice, reportedDetail, targetWorker, toolActual, toolObservation, toolPaths, toolReport } from './worker-tool-paths-fixture';

const configuration = (page: Page) => page.locator('[data-worker-panel="configuration"]:visible');
const toolsSummary = (page: Page) => configuration(page).locator('summary').filter({ hasText: /^工具路径/ });
const field = (page: Page, tool = 'codex') => page.locator(`#config-toolPaths-${tool}`);
const facts = (page: Page, tool = 'codex', context = 'web') => configuration(page).locator(`.worker-tool-path-details[data-tool="${tool}"] .worker-tool-context[data-context="${context}"]`);
const save = (page: Page) => page.locator('.config-save-bar').getByRole('button', { name: '保存配置', exact: true });
const cancel = (page: Page) => page.locator('.config-save-bar').getByRole('button', { name: '取消修改', exact: true });
const expandTools = async (page: Page) => { await toolsSummary(page).click(); await expect(field(page)).toBeVisible(); };
const noOverflow = (page: Page) => expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
const clearFocus = (page: Page) => expect.poll(() => page.evaluate(() => {
  const active = document.activeElement as HTMLElement, bar = document.querySelector('.config-save-bar')!.getBoundingClientRect();
  const rect = active.getBoundingClientRect();
  return rect.top >= 0 && rect.bottom <= bar.top;
})).toBe(true);

test('tool paths start collapsed and retain automatic choices until explicitly edited', async ({ page }) => {
  const state = await installTools(page); await openToolConfiguration(page);
  const summary = toolsSummary(page);
  await expect(summary).toBeVisible({ timeout: 3_000 });
  const input = page.locator('#config-toolPaths-codex');
  await expect(input).toBeHidden(); await summary.click();
  await expect(input).toBeVisible(); await expect(input).toHaveValue('');
  expect(state.writes).toHaveLength(0);
});

test('unadopted tools remain null and blank edits require explicit automatic reset', async ({ page }) => {
  const state = await installTools(page, { resource: observedConfiguration('1', { ...observedConfiguration().desired!.value, toolPaths: { codex: null, copilot: null, herdr: null } }) });
  await openToolConfiguration(page); await expandTools(page);
  await expect(field(page)).toHaveAttribute('placeholder', /等待.*导入/);
  await page.locator('#config-recoveryLimit').fill('7'); await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]!.value.toolPaths).toEqual({ codex: null, copilot: null, herdr: null });
  await field(page).fill('/opt/custom/codex'); await field(page).fill('');
  await expect(save(page)).toBeDisabled();
  await expect(configuration(page).getByText('请输入此 Worker 平台的绝对文件路径，最多 4096 UTF-8 字节，且不含控制字符。', { exact: true })).toBeVisible();
  const resets = configuration(page).getByRole('button', { name: '恢复自动', exact: true });
  await resets.first().click(); await save(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.value.toolPaths).toEqual({ codex: { kind: 'auto' }, copilot: null, herdr: null });
});

test('initial configuration loading does not invent an applied tool result', async ({ page }) => {
  const state = await installTools(page), gate = deferredRead(); state.configurationGate = gate;
  await page.goto(`/workers/${targetWorker}`); await page.locator('[data-worker-tab="configuration"]:visible').click();
  await gate.observed;
  try {
    await expect(configuration(page).getByRole('heading', { name: '正在读取配置' })).toBeVisible();
    await expect(field(page)).toHaveCount(0);
  } finally { gate.release(); state.configurationGate = null; }
  await expect(page.locator('#config-maxConcurrent')).toHaveValue('2'); await expandTools(page);
  await expect(field(page)).toBeEnabled();
});

for (const missing of ['service', 'worker'] as const) {
  test(`missing ${missing} capability disables only tool path editing`, async ({ page }) => {
    const state = await installTools(page, { [missing]: false }); await openToolConfiguration(page); await expandTools(page);
    for (const tool of ['codex', 'copilot', 'herdr']) await expect(field(page, tool)).toBeDisabled();
    await expect(configuration(page).getByRole('button', { name: '恢复自动', exact: true }).first()).toBeDisabled();
    await page.locator('#config-recoveryLimit').fill('7'); await save(page).click();
    await expect.poll(() => state.writes.length).toBe(1); expect(state.writes[0]!.value.recoveryLimit).toBe(7);
    expect(state.writes[0]!.value).not.toHaveProperty('toolPaths');
    await expect(page.locator('.config-save-bar').getByRole('status')).toHaveText('没有修改');
  });
}

test('offline supported Workers accept desired edits but label observed paths as historical', async ({ page }) => {
  const state = await installTools(page); state.detail = { ...reportedDetail(), observedAt: '2026-10-29T12:05:00Z' };
  await openToolConfiguration(page); await expandTools(page);
  await expect(field(page)).toBeEnabled(); await expect(facts(page)).toContainText('离线前记录');
  await field(page).fill('/opt/offline/codex'); await save(page).click();
  await expect.poll(() => state.writes.length).toBe(1);
  await expect(facts(page)).not.toContainText('已应用'); await expect(facts(page)).toContainText('/opt/installed/bin/codex');
});

test('errors retain the old actual record without combining the new target and old version', async ({ page }) => {
  const desired = pathChoice('/missing/new-codex');
  const state = await installTools(page, { resource: observedConfiguration('1', { ...observedConfiguration().desired!.value, toolPaths: { ...toolPaths, codex: desired } }) });
  state.detail = reportedDetail(toolReport([toolObservation('codex', 'web', { target: desired, state: 'error', error: { code: 'not_found', occurredAt: WORKER_TIME } })]));
  await openToolConfiguration(page); await expandTools(page);
  const context = facts(page); await expect(context).toContainText('应用失败');
  await expect(context).toContainText(/不存在/); await expect(field(page)).toHaveValue('/missing/new-codex');
  const actual = context.locator('[data-selection-role="actual"]');
  await expect(actual).toContainText('0.166.0'); await expect(actual).toContainText('/opt/installed/bin/codex'); await expect(actual).not.toContainText('/missing/new-codex');
});

test('shared Herdr waiting shows the old instance separately from the verified candidate', async ({ page }) => {
  const choice = pathChoice('/opt/herdr-new/bin/herdr'), old = toolActual('herdr', 'herdr');
  const candidate = toolActual('herdr', 'herdr', { selection: choice, selectionKey: '4'.repeat(64), source: 'explicit', entryPath: choice.path, executablePath: choice.path, version: '0.10.0' });
  const state = await installTools(page, { resource: observedConfiguration('1', { ...observedConfiguration().desired!.value, toolPaths: { ...toolPaths, herdr: choice } }) });
  state.detail = reportedDetail(toolReport([toolObservation('herdr', 'herdr', { target: choice, state: 'pending', reason: 'active_instance', candidate,
    activeSelectionCount: 1, activeSelections: [{ actual: old, executionCount: 2, instanceCount: 1, unconfirmedCount: 0 }] })]));
  await openToolConfiguration(page); await expandTools(page);
  const context = facts(page, 'herdr', 'herdr');
  await expect(context).toContainText('等待应用'); await expect(context.locator('[data-selection-role="candidate"]')).toContainText('0.10.0');
  await expect(context.locator('[data-selection-role="active"]')).toContainText('0.9.5');
  await expect(context.locator('[data-selection-role="active"]')).not.toContainText('/opt/herdr-new');
});

test('macOS running selections remain distinct and incomplete inventories stay explicit', async ({ page }) => {
  const current = toolActual('herdr', 'herdr'), older = toolActual('herdr', 'herdr', { selectionKey: '4'.repeat(64), entryPath: '/opt/herdr-old/bin/herdr', executablePath: '/opt/herdr-old/bin/herdr', version: '0.8.0' });
  const state = await installTools(page), detail = reportedDetail(toolReport([toolObservation('herdr', 'herdr', {
    activeSelectionCount: 3, activeSelectionsComplete: false, activeSelections: [
      { actual: current, executionCount: 1, instanceCount: 1, unconfirmedCount: 0 },
      { actual: older, executionCount: 1, instanceCount: 1, unconfirmedCount: 1 },
    ],
  })]));
  state.detail = { ...detail, worker: { ...detail.worker, platform: 'macos', telemetry: { ...detail.worker.telemetry, platform: 'macos' } } };
  await openToolConfiguration(page); await expandTools(page);
  const context = facts(page, 'herdr', 'herdr'), groups = context.locator('[data-selection-role="active"]');
  await expect(groups).toHaveCount(2); await expect(groups.nth(0)).toContainText('0.9.5'); await expect(groups.nth(1)).toContainText('0.8.0');
  await expect(context).toContainText('仍有未展示的运行选择'); await expect(context).toContainText('已应用');
});

test('older report revisions and unchecked contexts cannot make all configuration applied', async ({ page }) => {
  const state = await installTools(page, { resource: observedConfiguration('2') });
  state.detail = reportedDetail(toolReport([toolObservation('codex', 'web'), toolObservation('copilot', 'web', { targetRevision: '2', state: 'not_checked', actual: null })]));
  await openToolConfiguration(page); await expandTools(page);
  await expect(facts(page)).not.toContainText('已应用'); await expect(facts(page, 'copilot')).toContainText('等待检查');
  await expect(page.locator('.configuration-summary')).not.toContainText('已生效');
});

for (const locale of ['zh-CN', 'en'] as const) test(`${locale} software details share reported paths and keep Web and Herdr Copilot versions separate`, async ({ page }) => {
  const state = await installTools(page, { locale });
  state.detail = reportedDetail(toolReport([toolObservation('codex', 'web'), toolObservation('copilot', 'web'), toolObservation('copilot', 'herdr', {
    actual: toolActual('copilot', 'herdr', { version: '1.0.099' }),
  }), toolObservation('herdr', 'herdr')]));
  await page.goto(`/workers/${targetWorker}`);
  const software = page.locator('.worker-software-tool-paths[data-tool="copilot"]');
  await software.locator('summary').filter({ hasText: locale === 'zh-CN' ? '查看实际路径' : 'View actual paths' }).click();
  const web = software.locator('[data-context="web"]'), herdr = software.locator('[data-context="herdr"]');
  await expect(web).toContainText('1.0.105'); await expect(web).toContainText('/opt/daynight/runtime/copilot');
  await software.locator('summary').filter({ hasText: locale === 'zh-CN' ? '其他执行模式' : 'Other execution mode' }).click();
  await expect(herdr).toContainText('1.0.099'); await expect(herdr).toContainText('/opt/installed/bin/copilot');
  await expect(herdr).not.toContainText('/opt/daynight/runtime');
  await page.locator('[data-worker-tab="configuration"]:visible').click(); await configuration(page).locator('.configuration-tool-paths > summary').click();
  await expect(field(page, 'copilot')).toHaveAttribute('placeholder', locale === 'zh-CN' ? '自动' : 'Automatic');
  await expect(facts(page, 'copilot')).toContainText('1.0.105');
  await field(page, 'copilot').fill('/opt/draft/copilot');
  await field(page, 'copilot').evaluate(element => { (window as unknown as { toolPromptDraftNode: Element }).toolPromptDraftNode = element; });
  await page.locator('[data-worker-tab="prompt"]:visible').click();
  await expect(page.locator('[data-worker-panel="prompt"]:visible')).toBeVisible(); await expect(field(page, 'copilot')).toBeHidden();
  await page.locator('[data-worker-tab="configuration"]:visible').click(); await expect(field(page, 'copilot')).toHaveValue('/opt/draft/copilot');
  expect(await field(page, 'copilot').evaluate(element => element === (window as unknown as { toolPromptDraftNode: Element }).toolPromptDraftNode)).toBe(true);
  await page.locator('[data-worker-tab="overview"]:visible').click();
  await expect(web).toContainText('/opt/daynight/runtime/copilot'); await expect(software).not.toContainText('/opt/draft/copilot');
});

for (const width of [1440, 390, 320]) test(`software summary and full details survive refresh and language change at ${width}px`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const state = await installTools(page);
  const longPath = `/opt/${'long-directory/'.repeat(20)}codex`;
  const empty = (tool: 'codex' | 'copilot' | 'herdr', context: 'web' | 'herdr') => toolObservation(tool, context, { state: 'not_checked', actual: null });
  state.detail = reportedDetail(toolReport([
    toolObservation('codex', 'web', { actual: toolActual('codex', 'web', { entryPath: longPath, executablePath: longPath }) }), empty('codex', 'herdr'),
    toolObservation('copilot', 'web'), empty('copilot', 'herdr'), empty('herdr', 'herdr'),
  ]));
  await page.goto(`/workers/${targetWorker}`);
  const codex = page.locator('.worker-software-tool-paths[data-tool="codex"]');
  const copilot = page.locator('.worker-software-tool-paths[data-tool="copilot"]');
  await expect(codex.locator('.worker-tool-version')).toHaveText(['Web · 0.166.0']);
  await expect(copilot.locator('.worker-tool-version')).toHaveText(['Web · 1.0.105']);
  await expect(page.locator('.worker-software-tool-paths[data-tool="herdr"]')).toContainText('等待检查');
  const details = codex.locator('.worker-tool-software-details'), summary = details.locator(':scope > summary');
  await summary.focus(); await page.keyboard.press('Enter'); await expect(details).toHaveAttribute('open', '');
  const other = codex.locator('.worker-tool-other-context > summary');
  await other.focus(); await page.keyboard.press('Enter'); await expect(other.locator('..')).toHaveAttribute('open', '');
  await expect(codex.locator('[data-context="herdr"]')).toContainText('近期状态未确认');
  const path = codex.locator('[data-context="web"] [data-selection-role="actual"] .worker-tool-path-value').first();
  await path.locator(':scope > summary').click(); await expect(path).toContainText(longPath);
  await other.focus();
  const anchorTop = await other.evaluate(element => element.getBoundingClientRect().top);
  const gate = deferredRead(); state.workerGate = gate;
  const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/v1/me/workers/${targetWorker}` && value.request().method() === 'GET');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; document.dispatchEvent(new Event('visibilitychange')); });
  await gate.observed;
  try { await expect(other).toBeFocused(); await expect(details).toHaveAttribute('open', ''); await noOverflow(page); }
  finally { gate.release(); state.workerGate = null; await response; }
  await expect(other).toBeFocused(); await expect(path).toHaveAttribute('open', '');
  expect(await other.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(anchorTop, 0);
  await page.locator('.locale-control select').selectOption('en');
  await expect(details).toHaveAttribute('open', ''); await expect(path).toHaveAttribute('open', '');
  await expect(codex.locator('summary').filter({ hasText: 'Other execution mode' })).toBeFocused();
  expect(await other.evaluate(element => element.getBoundingClientRect().top)).toBeCloseTo(anchorTop, 0);
  await noOverflow(page);
  await info.attach('software-summary', { body: JSON.stringify({ width, codex: await codex.locator('.worker-tool-version').allTextContents(), copilot: await copilot.locator('.worker-tool-version').allTextContents(), scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth) }), contentType: 'application/json' });
});

for (const width of [1440, 390, 320]) for (const locale of ['zh-CN', 'en'] as const) {
  test(`${width}px ${locale} software details use the full row`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const long = `/Users/测试 用户/${'long-installation-directory/'.repeat(14)}bin/codex`;
    const actual = toolActual('codex', 'web', { entryPath: long, executablePath: long, interpreterPath: null });
    const state = await installTools(page, { locale });
    state.detail = reportedDetail(toolReport([toolObservation('codex', 'web', { actual }), toolObservation('copilot', 'web'), toolObservation('herdr', 'herdr')]));
    await page.goto(`/workers/${targetWorker}`);
    for (const tool of ['codex', 'copilot', 'herdr']) {
      const row = page.locator(`.worker-software-tool-paths[data-tool="${tool}"]`);
      const details = row.locator('.worker-tool-software-details');
      await details.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('open', '');
      const geometry = await row.evaluate(element => {
        const rowBox = element.getBoundingClientRect();
        const name = element.querySelector('dt')!.getBoundingClientRect();
        const summary = element.querySelector('dd')!.getBoundingClientRect();
        const detail = element.querySelector('.worker-tool-software-details')!.getBoundingClientRect();
        const facts = element.querySelector('.worker-tool-path-details')!.getBoundingClientRect();
        return { row: [rowBox.left, rowBox.right], detail: [detail.left, detail.right], facts: [facts.left, facts.right], nameTop: name.top, summaryTop: summary.top };
      });
      for (const edges of [geometry.detail, geometry.facts]) {
        expect(Math.abs(edges[0]! - geometry.row[0]!)).toBeLessThan(1);
        expect(Math.abs(edges[1]! - geometry.row[1]!)).toBeLessThan(1);
      }
      expect(Math.abs(geometry.nameTop - geometry.summaryTop)).toBeLessThan(1);
    }
    const codex = page.locator('.worker-software-tool-paths[data-tool="codex"]');
    await expect(codex.locator('[data-selection-role="actual"] .worker-tool-path-value')).toHaveCount(2);
    await expect(codex).toHaveCSS('row-gap', '0px');
    const entry = codex.locator('[data-selection-role="actual"] .worker-tool-path-value').first();
    await entry.locator('summary').focus(); await page.keyboard.press('Enter');
    await expect(entry.locator('code')).toHaveText(long);
    await entry.locator('button').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(long);
    await noOverflow(page);
    await codex.screenshot({ path: info.outputPath(`software-${width}-${locale}.png`) });
    await info.attach('software-layout', { path: info.outputPath(`software-${width}-${locale}.png`), contentType: 'image/png' });
  });
}

test('software path copy failure leaves the full value selectable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await installTools(page);
  await page.goto(`/workers/${targetWorker}`);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.reject(new Error('denied')) } }));
  const row = page.locator('.worker-software-tool-paths[data-tool="codex"]');
  await row.locator('.worker-tool-software-details > summary').click();
  const path = row.locator('[data-selection-role="actual"] .worker-tool-path-value').first();
  await path.locator('summary').click(); await path.locator('button').click();
  await expect(path.getByRole('status')).toHaveText('复制失败，请选择完整路径后复制。');
  const selection = await path.locator('code').evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selected = window.getSelection()!; selected.removeAllRanges(); selected.addRange(range);
    return selected.toString();
  });
  expect(selection).toBe('/opt/installed/bin/codex');
});

for (const sample of [{ width: 1440, locale: 'zh-CN' }, { width: 320, locale: 'en' }] as const) {
  test(`${sample.width}px ${sample.locale} software geometry stays stable throughout visibility revalidation`, async ({ page }, info) => {
    await page.setViewportSize({ width: sample.width, height: 900 });
    const state = await installTools(page, { locale: sample.locale }); await page.goto(`/workers/${targetWorker}`);
    const row = page.locator('.worker-software-tool-paths[data-tool="codex"]');
    const expanded = row.locator('.worker-tool-software-details'); await expanded.locator(':scope > summary').click();
    const other = row.locator('.worker-tool-other-context');
    await other.locator(':scope > summary').focus(); await page.keyboard.press('Enter');
    const path = row.locator('[data-context="web"] [data-selection-role="actual"] .worker-tool-path-value').first();
    const focus = path.locator(':scope > summary'); await focus.click(); await focus.focus();
    const selected = await path.locator('code').evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
      return selection.toString();
    });
    await row.evaluate(element => {
      const owner = window as unknown as { toolSoftwareNodes: Element[] };
      owner.toolSoftwareNodes = [element, element.closest('.worker-panel')!, element.querySelector('.worker-tool-software-details')!, element.querySelector('.worker-tool-path-value')!, element.querySelector('.worker-tool-other-context')!];
    });
    const measure = () => row.evaluate(element => {
      const software = element.closest('.worker-panel')!.getBoundingClientRect();
      const tasks = document.querySelector('.worker-task-heading-label')!.getBoundingClientRect();
      return { softwareHeight: software.height, tasksDocumentY: tasks.top + scrollY, scrollY };
    });
    const before = await measure(), gate = deferredRead(); state.workerGate = gate;
    const response = page.waitForResponse(value => new URL(value.url()).pathname === `/api/v1/me/workers/${targetWorker}` && value.request().method() === 'GET');
    const check = async () => {
      await expect(focus).toBeFocused(); await expect(expanded).toHaveAttribute('open', ''); await expect(path).toHaveAttribute('open', ''); await expect(other).toHaveAttribute('open', '');
      expect(await page.evaluate(() => window.getSelection()!.toString())).toBe(selected);
      expect(await row.evaluate(element => {
        const nodes = (window as unknown as { toolSoftwareNodes: Element[] }).toolSoftwareNodes;
        return [element, element.closest('.worker-panel'), element.querySelector('.worker-tool-software-details'), element.querySelector('.worker-tool-path-value'), element.querySelector('.worker-tool-other-context')].every((node, index) => node === nodes[index]);
      })).toBe(true);
      const current = await measure();
      expect(current.softwareHeight).toBeCloseTo(before.softwareHeight, 4);
      expect(current.tasksDocumentY).toBeCloseTo(before.tasksDocumentY, 4);
      expect(current.scrollY).toBeCloseTo(before.scrollY, 4);
    };
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
      delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; document.dispatchEvent(new Event('visibilitychange'));
    });
    await gate.observed;
    try {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await info.attach('pending-geometry', { body: JSON.stringify({ before, pending: await measure() }), contentType: 'application/json' });
      await check();
    } finally { gate.release(); state.workerGate = null; await response; }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect.poll(async () => {
      const value = await measure();
      return { softwareHeight: value.softwareHeight, tasksDocumentY: value.tasksDocumentY, scrollY: value.scrollY };
    }).toEqual(before);
    await check();
  });
}

test('background reads preserve the same input, focus, selection, expansion and scroll', async ({ page }) => {
  const state = await installTools(page); await openToolConfiguration(page); await expandTools(page);
  const input = field(page); await input.fill('/opt/draft/with spaces/codex'); await input.focus();
  await input.evaluate(element => { (element as HTMLInputElement).setSelectionRange(5, 10); (window as unknown as { toolInput: Element }).toolInput = element; });
  const scroll = await page.evaluate(() => scrollY), gate = deferredRead(); state.configurationGate = gate;
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; document.dispatchEvent(new Event('visibilitychange'));
  });
  await gate.observed;
  try {
    await expect(input).toHaveValue('/opt/draft/with spaces/codex'); await expect(input).toBeFocused();
    expect(await input.evaluate(element => element === (window as unknown as { toolInput: Element }).toolInput)).toBe(true);
    expect(await input.evaluate(element => [(element as HTMLInputElement).selectionStart, (element as HTMLInputElement).selectionEnd])).toEqual([5, 10]);
    expect(Math.abs(await page.evaluate(() => scrollY) - scroll)).toBeLessThan(2);
  } finally { gate.release(); state.configurationGate = null; }
  await expect(input).toHaveValue('/opt/draft/with spaces/codex'); await expect(input).toBeFocused();
  await expect(input).toBeVisible(); expect(state.writes).toHaveLength(0);
});

test('conflicts retain the draft and never replay a tool path write', async ({ page }) => {
  const state = await installTools(page); await openToolConfiguration(page); await expandTools(page);
  state.mode = 'conflict'; await field(page).fill('/opt/conflict/codex'); await save(page).click();
  await expect(page.getByText('云端配置已被其他页面修改。', { exact: true })).toBeVisible();
  await expect(field(page)).toHaveValue('/opt/conflict/codex'); await expect(save(page)).toBeDisabled();
  await page.locator('.configuration-toolbar button').click();
  await expect.poll(() => state.configurationReads).toBeGreaterThan(1); expect(state.writes).toHaveLength(1);
});

test('lost save responses reconcile the submitted path by GET without a second PUT', async ({ page }) => {
  const state = await installTools(page); await openToolConfiguration(page); await expandTools(page);
  state.mode = 'unknown'; await field(page).fill('/opt/response-lost/codex'); await save(page).click();
  await expect(page.getByText('保存结果尚未确认，当前草稿已保留。')).toBeVisible(); await expect(save(page)).toBeDisabled();
  state.unknownReads = false;
  await page.getByRole('button', { name: '核对保存结果' }).click();
  await expect(page.locator('.config-save-bar').getByRole('status')).toHaveText('没有修改');
  await expect(field(page)).toHaveValue('/opt/response-lost/codex'); expect(state.writes).toHaveLength(1);
  const following = state.events.slice(state.events.indexOf('PUT') + 1);
  expect(following.length).toBeGreaterThanOrEqual(2); expect(following.every(method => method === 'GET')).toBe(true);
  await expect(facts(page)).not.toContainText('已应用');
});

test('legacy unknown saves adopt untouched remote paths before tool support returns', async ({ page }) => {
  const original = pathChoice('/opt/original/codex'), remote = pathChoice('/opt/remote/codex');
  const state = await installTools(page, { resource: observedConfiguration('1', { ...observedConfiguration().desired!.value, toolPaths: { ...toolPaths, codex: original } }) });
  await openToolConfiguration(page); await expandTools(page);
  state.detail = workerDetail();
  const revalidate = () => page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange'));
    delete (document as { visibilityState?: DocumentVisibilityState }).visibilityState; document.dispatchEvent(new Event('visibilitychange'));
  });
  await revalidate(); await expect(field(page)).toBeDisabled();
  state.mode = 'unknown'; await page.locator('#config-recoveryLimit').fill('7'); await save(page).click();
  await expect(page.getByText('保存结果尚未确认，当前草稿已保留。')).toBeVisible();
  expect(state.writes).toHaveLength(1); expect(state.writes[0]!.value).not.toHaveProperty('toolPaths');
  state.resource = observedConfiguration('3', { ...state.resource.desired!.value, toolPaths: { ...toolPaths, codex: remote } });
  state.unknownReads = false;
  await page.getByRole('button', { name: '核对保存结果' }).click();
  await expect(field(page)).toHaveValue(remote.path);
  await expect(page.locator('.config-save-bar').getByRole('status')).toHaveText('没有修改');
  state.detail = reportedDetail(); state.mode = 'success';
  await revalidate(); await expect(field(page)).toBeEnabled();
  await page.locator('#config-recoveryLimit').fill('8'); await save(page).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[1]!.revision).toBe('3'); expect(state.writes[1]!.value.toolPaths?.codex).toEqual(remote);
});

for (const width of [1440, 390, 320]) {
  test(`${width}px full paths copy exactly and keyboard focus clears the fixed save bar`, async ({ page, context }, info) => {
    await page.setViewportSize({ width, height: 900 }); await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const long = `/Users/测试 用户/.nvm/versions/node/v24.22.1/${'long-installation-directory/'.repeat(14)}bin/codex`;
    const choice = pathChoice(long), actual = toolActual('codex', 'web', { selection: choice, source: 'explicit', entryPath: long, executablePath: long });
    const state = await installTools(page, { resource: observedConfiguration('1', { ...observedConfiguration().desired!.value, toolPaths: { ...toolPaths, codex: choice } }) });
    state.detail = reportedDetail(toolReport([toolObservation('codex', 'web', { target: choice, actual })]));
    await openToolConfiguration(page);
    const summary = toolsSummary(page); await summary.focus(); await page.keyboard.press('Enter');
    await expect(field(page)).toBeEnabled(); await field(page).focus(); await page.keyboard.press('Tab');
    await expect(configuration(page).getByRole('button', { name: '恢复自动', exact: true }).first()).toBeFocused();
    const entry = facts(page).locator('[data-selection-role="actual"] .worker-tool-path-value').first();
    await entry.locator('summary').click(); await expect(entry.locator('code')).toHaveText(long);
    await entry.getByRole('button', { name: '复制入口路径' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(long);
    await noOverflow(page); await page.screenshot({ path: info.outputPath(`paths-${width}.png`), fullPage: true });
    await page.locator('.configuration-tool-field[data-tool="codex"]').screenshot({ path: info.outputPath(`field-${width}.png`) });
    await info.attach(`tool-field-${width}`, { path: info.outputPath(`field-${width}.png`), contentType: 'image/png' });
    await field(page).fill('/opt/new/codex'); await field(page).focus();
    await expect(page.locator('.config-save-bar')).toHaveCSS('position', 'fixed'); await clearFocus(page); await noOverflow(page);
    await page.locator('a.worker-back-link').click(); await expect(page.getByRole('alertdialog')).toBeVisible();
    await page.getByRole('button', { name: '继续编辑' }).click(); await expect(field(page)).toBeFocused(); await clearFocus(page);
    await cancel(page).click(); await expect(field(page)).toHaveValue(long); expect(state.writes).toHaveLength(0);
    await field(page).fill('/opt/new/codex'); await save(page).click(); await expect.poll(() => state.writes.length).toBe(1);
    await expect(facts(page).locator('[data-selection-role="actual"]')).toContainText(long);
    await expect(facts(page)).not.toContainText('已应用'); await noOverflow(page);
    await page.screenshot({ path: info.outputPath(`saved-${width}.png`), fullPage: true });
  });
}
