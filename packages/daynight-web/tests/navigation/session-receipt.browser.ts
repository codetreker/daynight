import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { sessionFence, type SessionSnapshot } from '../../../daynight/src/session/protocol';

const source = JSON.parse(readFileSync(new URL('../../../daynight/test/session/fixtures/snapshot.json', import.meta.url), 'utf8'));
const owner = '00000009-1111-4111-8111-111111111111';
const personalId = '00000000-0000-4000-8000-000000000701';
const { claimId: _claim, ...base } = source;
const { projectId: _project, taskId: _task, workerId: _worker, worktreeId: _worktree, ...identity } = source.identity;
const snapshot: SessionSnapshot = { ...base, testExecutionId: '00000010-1111-4111-8111-111111111111', identity: { ...identity, ownerUserId: owner }, lastEventSeq: '0', lastTimelineSeq: '1', initialInputState: 'not_required' };
const root = `/api/v1/test-sessions/${snapshot.sessionId}`;
const failure = 'The provider did not accept the message. Check the current session status before trying again.';
const longFailure = `${failure} ${'Additional provider detail is preserved. '.repeat(24)}End of original detail.`;
const entries = [{ kind: 'assistant_message', entryId: '00000012-1111-4111-8111-111111111111', entrySeq: '1', revision: '1', content: [{ type: 'text', text: 'Readable conversation in the Test Session page.' }] }];

test.use({ hasTouch: true });

type Mode = 'failed' | 'unknown' | 'long' | 'success';
async function install(page: Page, initial: Mode) {
  const state = { mode: initial, posts: [] as string[], queries: [] as string[], resolve: false };
  await page.routeWebSocket('**/api/v1/test-sessions/**', socket => {
    socket.send(JSON.stringify({ protocol: snapshot.protocol, type: 'snapshot', userId: owner, snapshot, cursor: 'zero' }));
  });
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': owner } });
    if (path === '/api/v1/me') return send({ id: owner, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects' || path === '/api/v1/test-sessions') return send({ items: [], nextCursor: null });
    if (path === root) return send({ session: snapshot });
    if (path === `${root}/timeline`) return send({ sessionId: snapshot.sessionId, historyEpoch: snapshot.historyEpoch, items: entries, resources: [], beforeCursor: null, afterCursor: null, hasMoreBefore: false, hasMoreAfter: false, lastEventSeq: '0' });
    if (path === `${root}/commands` && request.method() === 'POST') {
      const command = request.postDataJSON(); state.posts.push(command.operationId);
      const phase = state.mode === 'success' ? 'provider_accepted' : state.mode === 'unknown' ? 'unknown' : 'failed';
      const message = state.mode === 'long' ? longFailure : failure;
      return send({ operation: { protocol: snapshot.protocol, ...sessionFence(snapshot), operationId: command.operationId, kind: command.kind, state: phase, providerResult: null, error: phase === 'failed' ? { code: 'provider_failed', message } : null }, operationUrl: `${root}/operations/${command.operationId}` }, 202);
    }
    if (path.startsWith(`${root}/operations/`)) {
      const id = path.slice(`${root}/operations/`.length); state.queries.push(id);
      return send({ operation: { protocol: snapshot.protocol, ...sessionFence(snapshot), operationId: id, kind: 'send_message', state: state.resolve ? 'provider_accepted' : 'unknown', providerResult: null, error: null } });
    }
    return send({ error: { code: 'not_found', message: 'Not found', requestId: snapshot.sessionId } }, 404);
  });
  return state;
}
async function open(page: Page, locale: string) {
  await page.addInitScript(locale => localStorage.setItem('daynight.web.locale', locale), locale);
  await page.goto(`/test-sessions/${snapshot.sessionId}`);
  await expect(page.getByText('Readable conversation in the Test Session page.')).toBeVisible();
  const input = page.locator('.session-composer textarea');
  await expect(input).toBeEnabled();
  return input;
}
async function submit(page: Page, input: ReturnType<Page['locator']>, text = 'Review the release draft.') {
  await input.fill(text); await input.focus();
  await page.locator('.session-composer button[type="submit"]').click();
}

for (const locale of ['en', 'zh-CN']) for (const [width, height] of [[320, 640], [375, 667], [390, 844], [768, 900], [1360, 900]]) {
  test(`${locale} ${width}x${height}: one complete failed receipt retains the draft`, async ({ page }, info) => {
    await page.setViewportSize({ width: width!, height: height! });
    const state = await install(page, 'failed'), input = await open(page, locale);
    const before = await page.locator('.session-composer').evaluate(node => node.getBoundingClientRect().height);
    await submit(page, input);
    await expect(page.locator('.session-receipt')).toHaveCount(1);
    await expect(page.getByText(failure, { exact: true })).toHaveCount(1);
    await expect(page.locator('.session-receipts[aria-live=polite]')).toHaveCount(1);
    await expect(page.locator('.session-composer [role=alert]')).toHaveCount(0);
    await expect(page.locator('.session-composer')).not.toContainText(failure);
    await expect(input).toHaveValue('Review the release draft.');
    expect(state.posts).toHaveLength(1);
    const geometry = await page.locator('.session-receipts').evaluate(node => {
      const receipt = node.querySelector('.session-receipt')!; const outer = node.getBoundingClientRect(), inner = receipt.getBoundingClientRect();
      return { overflow: node.scrollHeight > node.clientHeight, fits: inner.bottom <= outer.bottom && inner.top >= outer.top, width: document.documentElement.scrollWidth <= innerWidth };
    });
    expect(geometry).toEqual({ overflow: false, fits: true, width: true });
    const after = await page.locator('.session-composer').evaluate(node => node.getBoundingClientRect().height);
    expect(after).toBe(before);
    await info.attach('composer-geometry', { body: JSON.stringify({ locale, width, height, before, after, receipt: geometry }), contentType: 'application/json' });
    if (width === 320) await page.screenshot({ path: info.outputPath(`receipt-${locale}.png`) });
  });
}

test('unknown original is checked without another send, preserving selection and unrelated failure', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const state = await install(page, 'failed'), input = await open(page, 'en');
  await submit(page, input); await expect(page.locator('.session-receipt')).toHaveCount(1);
  state.mode = 'unknown'; await submit(page, input, 'An unresolved message');
  await expect(page.locator('.session-receipt')).toHaveCount(2);
  await expect(page.locator('.session-composer .session-notice')).toHaveCount(0);
  expect(state.posts).toHaveLength(2); const [failedId, unknownId] = state.posts;
  await input.fill('Later draft edits'); await input.focus(); await input.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(3, 10));
  state.resolve = true;
  const check = page.locator('.session-receipt').getByRole('button', { name: /check original operation/i });
  await check.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('.session-receipt')).toHaveCount(1);
  await expect(page.locator('.session-receipt')).toContainText(failure);
  expect(state.posts).toHaveLength(2); expect(state.queries).toContain(unknownId); expect(state.queries).not.toContain(failedId);
  await expect(input).toHaveValue('Later draft edits');
  expect(await input.evaluate((node: HTMLTextAreaElement) => [node.selectionStart, node.selectionEnd])).toEqual([3, 10]);
  await input.focus(); await expect(input).toBeFocused();
});

test('long detail is keyboard expandable without hiding the original text', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const state = await install(page, 'long'), input = await open(page, 'en');
  await submit(page, input); await expect(page.locator('.session-receipt')).toHaveCount(1);
  const detail = page.locator('.session-receipt details'); await expect(detail).toHaveCount(1);
  await detail.locator('summary').focus(); await page.keyboard.press('Enter');
  await expect(detail).toHaveAttribute('open', ''); await expect(detail).toContainText('End of original detail.');
  const content = detail.locator('[tabindex="0"]'); await content.focus(); await expect(content).toBeFocused();
  await input.focus(); await expect(input).toBeFocused(); expect(state.posts).toHaveLength(1);
});

test('successful send remains silent without a receipt placeholder', async ({ page }) => {
  const state = await install(page, 'success'), input = await open(page, 'en');
  await submit(page, input); await expect(input).toHaveValue('');
  await expect(page.locator('.session-receipts')).toHaveCount(0); expect(state.posts).toHaveLength(1);
});

for (const mode of ['failed', 'lost', 'upload'] as const) test(`image draft retains ownership through a ${mode} send`, async ({ page, context }) => {
  const { installDraftAPI, file } = await import('./session-drafts-api');
  const actor = '00000071-1111-4111-8111-111111111111';
  await page.setViewportSize({ width: 320, height: 640 });
  await context.route('**/api/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const send = (json: unknown, status = 200) => route.fulfill({ json, status, headers: { 'Daynight-User-ID': actor } });
    if (path === '/api/v1/me') return send({ id: actor, personalTeam: { id: personalId, kind: 'personal', name: null }, name: 'Reader', email: null, emailVerified: null, avatarUrl: null });
    if (path === '/api/v1/teams' || path === '/api/v1/projects' || path === '/api/v1/test-sessions') return send({ items: [], nextCursor: null });
    return send({ error: { code: 'not_found', message: 'Not found', requestId: snapshot.sessionId } }, 404);
  });
  const api = await installDraftAPI(context, {}, { testSession: true });
  if (mode === 'upload') api.completeNextAs('failed'); else api.setDispatch(mode);
  api.setQuery('404');
  await page.goto(`/test-sessions/${snapshot.sessionId}`);
  const input = page.locator('.session-composer textarea'); await expect(input).toBeEditable();
  await input.fill('Caption for retained image'); await page.locator('input[type=file]').setInputFiles(file('Retained.png'));
  await expect(page.getByRole('button', { name: /view image: retained\.png/i })).toBeVisible();
  if (mode === 'upload') {
    await expect(page.locator('.session-draft-attachments [role=alert]').first()).toBeVisible();
    await expect(page.locator('.session-receipts')).toHaveCount(0);
    await expect(input).toHaveValue('Caption for retained image');
    expect(api.observations.commands).toHaveLength(0); return;
  }
  const send = page.locator('.session-composer button[type="submit"]'); await expect(send).toBeEnabled(); await send.click();
  await expect.poll(() => api.observations.commands.length).toBe(1);
  const original = api.observations.commands[0]!.operationId;
  await expect(page.locator('.session-receipt')).toHaveCount(1);
  if (mode === 'failed') {
    await expect(page.locator('.session-receipt')).toContainText(failure);
    await expect(page.locator('.session-composer')).not.toContainText(failure);
    await expect(input).toHaveValue('Caption for retained image');
    await expect(page.getByRole('button', { name: /view image: retained\.png/i })).toBeVisible();
  } else {
    await expect(page.locator('.session-receipt').getByRole('button', { name: /check original operation/i })).toBeVisible();
    api.setQuery('provider_accepted');
    await page.locator('.session-receipt').getByRole('button', { name: /check original operation/i }).tap();
    await expect(page.locator('.session-receipt')).toHaveCount(0);
    expect(api.observations.queries).toContain(original);
    expect(api.observations.queries.every(id => id === original)).toBe(true);
  }
  expect(api.observations.commands).toHaveLength(1);
});


test('identical failures from different operations retain distinct, reachable receipts', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const state = await install(page, 'failed'), input = await open(page, 'en');
  await submit(page, input); await expect(page.locator('.session-receipt')).toHaveCount(1);
  await submit(page, input, 'Second draft'); await expect(page.locator('.session-receipt')).toHaveCount(2);
  expect(state.posts).toHaveLength(2); expect(state.posts[0]).not.toBe(state.posts[1]);
  const receipts = page.locator('.session-receipt');
  await expect(receipts.nth(0)).toContainText(state.posts[0]!); await expect(receipts.nth(1)).toContainText(state.posts[1]!);
  await expect(page.getByText(failure, { exact: true })).toHaveCount(2);
  const region = page.locator('.session-receipts'); await region.focus(); await expect(region).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => region.evaluate((node: HTMLElement) => ({ top: node.scrollTop, end: node.scrollTop + node.clientHeight >= node.scrollHeight - 1 }))).toMatchObject({ end: true });
  expect(await region.evaluate((node: HTMLElement) => node.scrollTop)).toBeGreaterThan(0);
  await input.focus(); await expect(input).toBeFocused(); await expect(input).toHaveValue('Second draft');
});
