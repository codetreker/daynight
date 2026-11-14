import { expect, test, type Page } from '@playwright/test';
import { BOT_TIME, BOT_USER, botAttentionHeaders, botDefaults, botDefinition, botId } from '../helpers/bots';

const taskId = botId(80), firstProposalId = botId(81), secondProposalId = botId(82), personalId = botId(100);
const personal = { id: personalId, kind: 'personal', name: null };
const profile = { id: BOT_USER, personalTeam: personal, name: 'Assistant tasks fixture', email: null, emailVerified: null, avatarUrl: null };
const team = { ...personal, version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME, membership: { teamId: personalId, userId: BOT_USER, role: 'admin', version: 1, createdAt: BOT_TIME, updatedAt: BOT_TIME } };
const task = { id: taskId, ownerUserId: BOT_USER, name: 'Outcome coordination', purpose: 'Review progress and record observed outcomes', scope: 'Assigned work', application: '', kind: 'continuous', state: 'active', takeover: 'manual', trigger: null, version: '7', manualVersion: '1', claimGeneration: '1', claimState: 'active', holderBotId: botId(1), credentialOperationId: botId(83), claimedAt: BOT_TIME, renewedAt: BOT_TIME, leaseUntil: '2099-01-01T00:00:00Z', observedAt: BOT_TIME, createdAt: BOT_TIME, updatedAt: BOT_TIME };
const original = { taskId, version: '1', body: '## Original manual\n\nRead the actual outcome.\n\n' + 'LongUnbrokenEvidence'.repeat(150), rules: [], source: 'initial', proposalId: null as string | null, createdAt: BOT_TIME };
const revision = { ...original, version: '2', body: '## Approved manual\n\nUse the verified evidence.', source: 'revision', proposalId: firstProposalId };
const rollback = { ...original, version: '3', source: 'rollback' };
const proposal = (id: string, reason: string) => ({ id, taskId, baseVersion: '1', body: revision.body, rules: [], reason, evidenceRecords: [], authorBotId: botId(1), widens: id === firstProposalId, status: 'pending', decisionNote: '', createdAt: BOT_TIME, decidedAt: null as string | null });
const longName = 'Long assistant name 很长助手名称 1234567890';
const itemId = botId(50);
const item = { id: itemId, taskId, key: 'Long item key 很长事项 '.repeat(8).trim(), episode: '1', state: 'open', category: 'stalled', followerBotId: botId(2), appState: {}, version: '1', createdAt: BOT_TIME, updatedAt: BOT_TIME };
const record = { id: botId(51), taskId, itemId, kind: 'fact', author: 'bot', authorBotId: botId(2), text: 'Selected evidence', refs: [], createdAt: BOT_TIME };
async function install(page: Page, options: { noBots?: boolean } = {}) {
  let currentTask = { ...task }, currentManual = { ...original };
  const histories = [{ ...original }];
  const proposals = [proposal(firstProposalId, 'Repeated successful observations'), proposal(secondProposalId, 'Unverified alternative')];
  const writes: { path: string; input: unknown }[] = [];
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': BOT_USER, ...botAttentionHeaders(route.request().headers(), status) } });
    const paged = (items: unknown[]) => ({ items, nextCursor: null, observedAt: BOT_TIME });
    if (request.method() !== 'GET') {
      const input = request.postDataJSON(); writes.push({ path, input });
      if (path === `/api/v1/assistant-tasks/${taskId}/proposals/${firstProposalId}/decision`) {
        expect(input).toEqual({ ifVersion: '7', decision: 'approved', note: '' });
        proposals[0] = { ...proposals[0]!, status: 'approved', decidedAt: BOT_TIME };
        currentTask = { ...currentTask, version: '8', manualVersion: '2' }; currentManual = { ...revision }; histories.push({ ...revision });
        return send(proposals[0]);
      }
      if (path === `/api/v1/assistant-tasks/${taskId}/proposals/${secondProposalId}/decision`) {
        expect(input).toEqual({ ifVersion: '8', decision: 'rejected', note: 'Need independently verified evidence' });
        proposals[1] = { ...proposals[1]!, status: 'rejected', decisionNote: input.note, decidedAt: BOT_TIME };
        currentTask = { ...currentTask, version: '9' }; return send(proposals[1]);
      }
      if (path === `/api/v1/assistant-tasks/${taskId}/manual/rollback`) {
        expect(input).toEqual({ ifVersion: '9', manualVersion: '1' });
        currentTask = { ...currentTask, version: '10', manualVersion: '3' }; currentManual = { ...rollback }; histories.push({ ...rollback }); return send(rollback);
      }
      throw new Error(`Unexpected browser write: ${request.method()} ${path}`);
    }
    if (path === '/api/v1/me') return send(profile);
    if (path === '/api/v1/teams') return send({ items: [], nextCursor: null });
    if (path === `/api/v1/teams/${personalId}`) return send(team);
    if (path === '/api/v1/projects') return send({ items: [], nextCursor: null });
    if (path === '/api/v1/me/bots/defaults') return send(botDefaults());
    if (path === '/api/v1/me/bots') return send({ items: options.noBots ? [] : [botDefinition(1), { ...botDefinition(2), name: longName }], nextCursor: null });
    if (path === '/api/v1/assistant-tasks') return send(paged([currentTask]));
    if (path === `/api/v1/assistant-tasks/${taskId}`) return send(currentTask);
    if (path.endsWith('/manual')) return send(currentManual);
    if (path.endsWith('/manual/versions')) return send(paged(histories));
    if (path.endsWith('/proposals')) return send(paged(proposals));
    if (path.endsWith('/items')) return send(paged([item]));
    if (path.endsWith('/records')) return send(paged([record]));
    if (path.endsWith('/appendix') || path.endsWith('/events') || path === '/api/v1/assistant-task-events') return send(paged([]));
    return send({ error: { code: 'not_found', message: 'Not found', requestId: 'assistant-task-fixture' } }, 404);
  });
  return writes;
}
const noOverflow = async (page: Page) => {
  const bounds = await page.locator('.assistant-task-detail').evaluate(node => ({ right: node.getBoundingClientRect().right, width: innerWidth, document: document.documentElement.scrollWidth }));
  expect(bounds.document).toBeLessThanOrEqual(bounds.width);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 1);
};
for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}px assistant task`, () => {
    test.use({ viewport });
    test('supports keyboard decisions and historical rollback without overflowing long content', async ({ page }, testInfo) => {
      const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
      const writes = await install(page);
      await page.goto(`/bots/tasks/${taskId}`);
      const detail = page.locator('.assistant-task-detail');
      await expect(detail.getByRole('heading', { name: 'Original manual' })).toBeVisible();
      await noOverflow(page);
      await detail.getByRole('button', { name: 'Pause', exact: true }).focus();
      await page.keyboard.press('Tab'); await expect(detail.getByRole('button', { name: 'Release', exact: true })).toBeFocused();
      await page.keyboard.press('Enter'); await expect(page.getByRole('dialog', { name: 'Release', exact: true })).toBeVisible();
      await page.keyboard.press('Escape'); await expect(detail.getByRole('button', { name: 'Release', exact: true })).toBeFocused();
      await detail.getByRole('button', { name: 'Pending proposals (2)' }).click();
      await expect(detail.getByText('Expands direct actions', { exact: true })).toBeVisible();
      const first = page.locator(`#proposal-${firstProposalId}`);
      await first.getByRole('button', { name: 'Approve', exact: true }).focus(); await page.keyboard.press('Enter');
      await expect(detail.getByRole('button', { name: 'Pending proposals (1)' })).toBeVisible();
      const second = page.locator(`#proposal-${secondProposalId}`);
      await second.getByRole('button', { name: 'Reject', exact: true }).click();
      await second.getByRole('textbox', { name: 'Reason for rejection' }).fill('Need independently verified evidence');
      await second.getByRole('button', { name: 'Reject', exact: true }).press('Enter');
      await expect(detail.getByText('No pending proposals')).toBeVisible();
      await detail.getByRole('button', { name: 'Work manual', exact: true }).click();
      await expect(detail.getByRole('heading', { name: 'Approved manual' })).toBeVisible();
      await detail.getByRole('button', { name: 'Revision history · v2' }).click();
      await expect(detail.getByText('Need independently verified evidence')).toBeVisible();
      await detail.getByRole('button', { name: 'Roll back to v1', exact: true }).click();
      await detail.getByRole('button', { name: 'Confirm rollback', exact: true }).press('Enter');
      await expect(detail.getByRole('button', { name: 'Revision history · v3' })).toBeVisible();
      await detail.getByRole('button', { name: 'Manual', exact: true }).click();
      await expect(detail.getByRole('heading', { name: 'Original manual' })).toBeVisible();
      await noOverflow(page); expect(writes).toHaveLength(3); expect(errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('assistant-task.png') });
      await testInfo.attach('assistant-task-evidence', { body: JSON.stringify({ viewport, boundary: 'Production app and frontend HTTP parsing with controlled service responses; no backend acceptance.', writes, errors }), contentType: 'application/json' });
    });
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 320, height: 568 }]) {
  test(`assistant selection fields preserve choices and fit at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const writes = await install(page); await page.goto('/bots');
    await page.getByRole('button', { name: 'Create assistant task', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create assistant task' });
    await create.getByLabel('Name', { exact: true }).fill('Retained draft');
    await create.getByRole('combobox', { name: 'Kind', exact: true }).selectOption('once');
    await expect(create.getByRole('combobox', { name: 'Kind', exact: true })).toHaveValue('once');
    await expect(create.getByLabel('Name', { exact: true })).toHaveValue('Retained draft');
    expect(await create.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await create.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('button', { name: 'Enable Watchdog', exact: true }).click();
    const watchdog = page.getByRole('dialog', { name: 'Enable Watchdog' });
    const bot = watchdog.getByRole('combobox', { name: 'Choose an assistant' });
    await expect(bot).toHaveValue(botId(1)); await bot.selectOption(botId(2));
    await expect(bot.locator('option:checked')).toHaveText(longName);
    expect(await watchdog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await watchdog.getByRole('button', { name: 'Cancel' }).click(); expect(writes).toHaveLength(0);

    await page.goto(`/bots/tasks/${taskId}`);
    const detail = page.locator('.assistant-task-detail');
    await detail.getByRole('button', { name: 'Transfer', exact: true }).click();
    const transfer = page.getByRole('dialog', { name: 'Transfer' });
    const target = transfer.getByRole('combobox', { name: 'Choose an assistant' });
    await expect(target).toHaveValue(botId(2)); await expect(target.locator(`option[value="${botId(1)}"]`)).toHaveCount(0);
    await expect(target.locator('option:checked')).toHaveText(longName);
    expect(await transfer.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    await transfer.getByRole('button', { name: 'Cancel' }).click(); expect(writes).toHaveLength(0);

    await detail.getByRole('button', { name: 'Work records', exact: true }).click();
    const section = detail.locator('.assistant-task-record-section');
    await expect(section.getByText('Selected evidence')).toBeVisible();
    await section.getByRole('combobox', { name: 'Item', exact: true }).selectOption(itemId);
    await section.getByRole('combobox', { name: 'Record type', exact: true }).selectOption('fact');
    await section.getByRole('combobox', { name: 'Author', exact: true }).selectOption(botId(2));
    await expect(section.getByText('Selected evidence')).toBeVisible();
    await expect(section.getByRole('combobox', { name: 'Item', exact: true }).locator('option:checked')).toHaveText(item.key);
    await noOverflow(page); expect(writes).toHaveLength(0);
    await section.getByRole('button', { name: 'Clear filters' }).click();
    await expect(section.getByRole('combobox', { name: 'Item', exact: true })).toHaveValue('');
    await expect(section.getByRole('combobox', { name: 'Record type', exact: true })).toHaveValue('');
    await expect(section.getByRole('combobox', { name: 'Author', exact: true })).toHaveValue('');
  });
}

test('empty assistant choice retains native required validation and prevents a watchdog write', async ({ page }) => {
  const writes = await install(page, { noBots: true }); await page.goto('/bots');
  await page.getByRole('button', { name: 'Enable Watchdog', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Enable Watchdog' }), select = dialog.getByRole('combobox', { name: 'Choose an assistant' });
  await expect(select).toHaveValue(''); await expect(select).toHaveAttribute('required', '');
  expect(await select.evaluate(node => (node as HTMLSelectElement).validity.valueMissing)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'Enable Watchdog' })).toBeDisabled();
  const invalid = await select.evaluate(node => {
    let count = 0;
    node.addEventListener('invalid', () => { count++; }, { once: true });
    (node as HTMLSelectElement).form!.requestSubmit();
    return count;
  });
  expect(invalid).toBe(1);
  expect(writes).toHaveLength(0);
});
